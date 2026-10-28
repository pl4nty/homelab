const express = require('express');
const path = require('path');
const { ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");
const { TokenCredentialAuthenticationProvider } = require("@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials");
require('isomorphic-fetch');

const app = express();
const port = 3000;

// Serve static files (e.g., index.html, css/site.css)
app.use(express.static(__dirname));

// Create an instance of the TokenCredential class that is imported
const credential = new ClientSecretCredential(process.env.AZURE_TENANT_ID, process.env.AZURE_CLIENT_ID, process.env.AZURE_CLIENT_SECRET);
const authProvider = new TokenCredentialAuthenticationProvider(credential, { scopes: [".default"] });
const client = Client.initWithMiddleware({ authProvider });

// Handle GET requests to /api with tenantId query parameter
app.get('/api', async (req, res) => {
    const tenantId = req.query.tenantId;

    if (!tenantId) {
        return res.status(400).send('tenantId query parameter is required');
    }

    try {
        // Call the Microsoft Graph API to get tenant information
        const tenantInfo = await client
            .api(`/tenantRelationships/findTenantInformationByTenantId(tenantId='${tenantId}')`)
            .get();

        // Use tenantInfo.defaultDomainName to call another API
        const domain = tenantInfo.defaultDomainName;
        const response = await fetch(`https://login.microsoftonline.com/common/userrealm/${domain}?api-version=2.1`);
        const domainInfo = await response.json();

        // Merge the resulting JSON with tenantInfo
        const mergedInfo = { ...tenantInfo, ...domainInfo };

        // Send the merged response back to the client
        res.json(mergedInfo);
    } catch (error) {
        console.error('Error fetching tenant information:', error);
        res.status(500).send('Error fetching tenant information');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
