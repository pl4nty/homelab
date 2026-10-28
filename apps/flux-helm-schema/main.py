from fastapi import FastAPI, HTTPException
import requests
import json

app = FastAPI()

# Load the helm release schema on startup
with requests.get("https://raw.githubusercontent.com/fluxcd-community/flux2-schemas/refs/heads/main/helmrelease-helm-v2.json") as response:
    if response.status_code != 200:
        raise HTTPException(status_code=500, detail="Failed to load helm release schema")
    helm_release_schema = response.json()

@app.get("/")
def merge_schema(values: str):
    # Insert the downloaded schema under spec.values in the helm release schema
    helm_release_schema["properties"]["spec"]["properties"]["values"]["$ref"] = values

    # Return the merged schema in the response body
    return helm_release_schema
