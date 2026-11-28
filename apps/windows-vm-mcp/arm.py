"""Azure Resource Manager REST calls for the devbox VMs."""

import asyncio
import os
import time
from pathlib import Path

import httpx

ARM = "https://management.azure.com"
COMPUTE_API = "2024-11-01"
NETWORK_API = "2024-05-01"
DEVTESTLAB_API = "2018-09-15"
TAGS_API = "2021-04-01"
TAG = "windows-vm-mcp"


class AzureError(RuntimeError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code


class Azure:
    def __init__(self) -> None:
        self.tenant = os.environ.get("AZURE_TENANT_ID", "")
        self.client_id = os.environ.get("AZURE_CLIENT_ID", "")
        self.client_secret = os.environ.get("AZURE_CLIENT_SECRET", "")
        self.federated_token_file = os.environ.get("AZURE_FEDERATED_TOKEN_FILE", "")
        self.subscription = os.environ.get("AZURE_SUBSCRIPTION_ID", "")
        self.group = os.environ.get("AZURE_RESOURCE_GROUP", "windows-vm-mcp")
        self.location = os.environ.get("AZURE_LOCATION", "australiaeast")
        self.http = httpx.AsyncClient(timeout=120)
        self._token = ""
        self._expires = 0.0

    @property
    def configured(self) -> bool:
        return bool(self.tenant and self.client_id and self.subscription)

    @property
    def scope(self) -> str:
        return f"/subscriptions/{self.subscription}/resourceGroups/{self.group}"

    def vm_id(self, name: str) -> str:
        return f"{self.scope}/providers/Microsoft.Compute/virtualMachines/{name}"

    async def token(self) -> str:
        if self._token and time.time() < self._expires - 300:
            return self._token
        if not self.configured:
            raise AzureError(
                0,
                "NotConfigured",
                "set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_SUBSCRIPTION_ID",
            )
        data = {
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "scope": f"{ARM}/.default",
        }
        if self.federated_token_file:
            assertion = await asyncio.to_thread(Path(self.federated_token_file).read_text)
            data["client_assertion"] = assertion.strip()
            data["client_assertion_type"] = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        else:
            data["client_secret"] = self.client_secret
        resp = await self.http.post(
            f"https://login.microsoftonline.com/{self.tenant}/oauth2/v2.0/token", data=data
        )
        body = resp.json()
        if resp.status_code != 200:
            raise AzureError(
                resp.status_code, body.get("error", ""), body.get("error_description", "")
            )
        self._token = body["access_token"]
        self._expires = time.time() + int(body["expires_in"])
        return self._token

    async def request(
        self, method: str, path: str, api: str, body: dict | None = None, ok404: bool = False
    ) -> httpx.Response:
        url = path if path.startswith("https://") else f"{ARM}{path}"
        params = None if "api-version=" in url else {"api-version": api}
        for attempt in range(5):
            resp = await self.http.request(
                method,
                url,
                params=params,
                json=body,
                headers={"Authorization": f"Bearer {await self.token()}"},
            )
            if resp.status_code != 429 or attempt == 4:
                break
            await asyncio.sleep(int(resp.headers.get("Retry-After", "10")))
        if resp.status_code == 404 and ok404:
            return resp
        if resp.status_code >= 400:
            try:
                error = resp.json()["error"]
                raise AzureError(resp.status_code, error.get("code", ""), error.get("message", ""))
            except (ValueError, KeyError):
                raise AzureError(resp.status_code, str(resp.status_code), resp.text) from None
        return resp

    async def wait(self, resp: httpx.Response, timeout: float = 1800) -> dict:
        """Follow an ARM long-running operation to its end."""
        deadline = time.monotonic() + timeout
        async_url = resp.headers.get("Azure-AsyncOperation")
        location = resp.headers.get("Location")
        while time.monotonic() < deadline:
            if async_url:
                await asyncio.sleep(int(resp.headers.get("Retry-After", "5")))
                resp = await self.request("GET", async_url, COMPUTE_API)
                body = resp.json()
                status = body.get("status")
                if status == "Succeeded":
                    return body
                if status in ("Failed", "Canceled"):
                    error = body.get("error", {})
                    raise AzureError(200, error.get("code", status), error.get("message", status))
            elif location and resp.status_code == 202:
                await asyncio.sleep(int(resp.headers.get("Retry-After", "5")))
                resp = await self.request("GET", location, COMPUTE_API)
            else:
                return resp.json() if resp.content else {}
        raise TimeoutError("Azure operation did not finish in time")

    async def ensure_network(self) -> str:
        vnet = f"{self.scope}/providers/Microsoft.Network/virtualNetworks/{TAG}"
        subnet = f"{vnet}/subnets/default"
        if (await self.request("GET", subnet, NETWORK_API, ok404=True)).status_code == 404:
            # the agent only dials out, so default outbound access replaces a public IP or NAT gateway
            resp = await self.request(
                "PUT",
                vnet,
                NETWORK_API,
                {
                    "location": self.location,
                    "tags": {TAG: "true"},
                    "properties": {
                        "addressSpace": {"addressPrefixes": ["10.70.0.0/24"]},
                        "subnets": [
                            {
                                "name": "default",
                                "properties": {
                                    "addressPrefix": "10.70.0.0/24",
                                    "defaultOutboundAccess": True,
                                },
                            }
                        ],
                    },
                },
            )
            await self.wait(resp)
        return subnet

    async def create_nic(self, name: str, subnet: str) -> str:
        nic = f"{self.scope}/providers/Microsoft.Network/networkInterfaces/{name}"
        resp = await self.request(
            "PUT",
            nic,
            NETWORK_API,
            {
                "location": self.location,
                "tags": {TAG: "true"},
                "properties": {
                    "ipConfigurations": [
                        {"name": "ipconfig", "properties": {"subnet": {"id": subnet}}}
                    ]
                },
            },
        )
        await self.wait(resp)
        return nic

    async def put_vm(self, name: str, body: dict) -> httpx.Response:
        return await self.request("PUT", self.vm_id(name), COMPUTE_API, body)

    async def get_vm(self, name: str) -> dict | None:
        resp = await self.request(
            "GET",
            f"{self.vm_id(name)}?api-version={COMPUTE_API}&$expand=instanceView",
            COMPUTE_API,
            ok404=True,
        )
        return None if resp.status_code == 404 else resp.json()

    async def list_vms(self) -> list[dict]:
        url = (
            f"{self.scope}/providers/Microsoft.Compute/virtualMachines"
            f"?api-version={COMPUTE_API}&statusOnly=true"
        )
        vms = []
        while url:
            body = (await self.request("GET", url, COMPUTE_API, ok404=True)).json()
            vms += [vm for vm in body.get("value", []) if TAG in (vm.get("tags") or {})]
            url = body.get("nextLink")
        return vms

    async def action(self, name: str, verb: str, body: dict | None = None) -> httpx.Response:
        return await self.request("POST", f"{self.vm_id(name)}/{verb}", COMPUTE_API, body)

    async def delete_vm(self, name: str) -> httpx.Response:
        await self.request(
            "DELETE",
            f"{self.scope}/providers/Microsoft.DevTestLab/schedules/shutdown-computevm-{name}",
            DEVTESTLAB_API,
            ok404=True,
        )
        return await self.request("DELETE", self.vm_id(name), COMPUTE_API, ok404=True)

    async def merge_tags(self, name: str, tags: dict[str, str]) -> None:
        await self.request(
            "PATCH",
            f"{self.vm_id(name)}/providers/Microsoft.Resources/tags/default",
            TAGS_API,
            {"operation": "Merge", "properties": {"tags": tags}},
        )

    async def schedule_shutdown(self, name: str, time_of_day: str, time_zone: str) -> None:
        await self.request(
            "PUT",
            f"{self.scope}/providers/Microsoft.DevTestLab/schedules/shutdown-computevm-{name}",
            DEVTESTLAB_API,
            {
                "location": self.location,
                "tags": {TAG: "true"},
                "properties": {
                    "status": "Enabled",
                    "taskType": "ComputeVmShutdownTask",
                    "dailyRecurrence": {"time": time_of_day},
                    "timeZoneId": time_zone,
                    "notificationSettings": {"status": "Disabled"},
                    "targetResourceId": self.vm_id(name),
                },
            },
        )
