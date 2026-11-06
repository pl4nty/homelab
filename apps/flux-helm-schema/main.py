import copy

import requests
from fastapi import FastAPI

app = FastAPI()

# Load the helm release schema on startup
response = requests.get(
    "https://raw.githubusercontent.com/fluxcd-community/flux2-schemas/refs/heads/main/helmrelease-helm-v2.json",
    timeout=30,
)
response.raise_for_status()
helm_release_schema = response.json()


@app.get("/")
def merge_schema(values: str):
    # copy per request: handlers run concurrently, so editing the shared schema
    # could return another request's values ref
    schema = copy.deepcopy(helm_release_schema)
    schema["properties"]["spec"]["properties"]["values"]["$ref"] = values
    return schema
