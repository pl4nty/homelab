// stuff
var plainTextResults = "";
var lookupEnvironment = "Global/USGov";

// define some global variables so we can use them later without having to re-declare stuff.
var tenantPartitionRow;
var tenantClassRow;
var lookupError;
var lookupResults;
var errorGccTenantInGov;
var errorGccHTenantInGov;
var fairfaxMigrationBlurb;
var infoBox;
var spinner;

window.addEventListener('load',
    function () {
        // once the DOM is loaded, let's go get our various bits.
        tenantPartitionRow = $('#azureADInstance');
        tenantClassRow = $('#tenantSubScope');
        lookupError = $('#tenantLookupFail');
        lookupResults = $('#tenantLookupResults');
        errorGccTenantInGov = $('#gccTenantInGov');
        errorGccHTenantInGov = $('#gccTenantInGov');
        fairfaxMigrationBlurb = $('#fairfaxMigrationBlurb');
        infoBox = $('#infoBox');
        spinner = $('#searchingSpinner');
        spinner.hide();

        // here's the handler code for changing the environment dropdown
        $('#environmentList a').click(function () {
            appInsights.trackEvent({ name: "ChangeEnvironment" });
            lookupEnvironment = $(this).text();
            $('#btnEnvironmentPick').text(lookupEnvironment);

            switch (lookupEnvironment) {
                case 'Worldwide':
                    $('#tenantToLookup').attr("placeholder", "contoso.onmicrosoft.com");
                    break;
                case 'US Government':
                    $('#tenantToLookup').attr("placeholder", "contoso.onmicrosoft.us");
                    break;
                case 'China':
                    appInsights.trackEvent({ name: "SelectChinaEnvironment" });
                    $('#tenantToLookup').attr("placeholder", "contoso.partner.onmschina.cn");
                    break;
                case 'Germany': // deprecated
                    appInsights.trackEvent({ name: "SelectGermanyEnvironment" });
                    $('#tenantToLookup').attr("placeholder", "contoso.onmicrosoft.de");
                    break;
                case 'PreProduction':
                    $('#tenantToLookup').attr("placeholder", "microsoft.com");
                    break;
                default:
                    $('#tenantToLookup').attr("placeholder", "contoso.onmicrosoft.com");
            }

        });

    }, false);

function copyResults() {
    appInsights.trackEvent({ name: "CopyToClipboard" });
    const el = document.createElement('textarea');  // Create a <textarea> element
    el.value = plainTextResults;                    // Set its value to the string that you want copied
    el.setAttribute('readonly', '');                // Make it readonly to be tamper-proof
    el.style.position = 'absolute';
    el.style.left = '-9999px';                      // Move outside the screen to make it invisible
    document.body.appendChild(el);                  // Append the <textarea> element to the HTML document
    const selected =
        document.getSelection().rangeCount > 0        // Check if there is any content selected previously
            ? document.getSelection().getRangeAt(0)     // Store selection if found
            : false;                                    // Mark as false to know no selection existed before
    el.select();                                    // Select the <textarea> content
    document.execCommand('copy');                   // Copy - only works as a result of a user action (e.g. click events)
    document.body.removeChild(el);                  // Remove the <textarea> element
    if (selected) {                                 // If a selection existed before copying
        document.getSelection().removeAllRanges();    // Unselect everything on the HTML document
        document.getSelection().addRange(selected);   // Restore the original selection
    }
};

function lookupTenant() {
    // reset the error dialog if there is one.
    ResetView();
    spinner.show();

    appInsights.trackEvent({ name: "LookupTenant" });

    var xmlhttp = new XMLHttpRequest();
    var tenant = $("#tenantToLookup").val().trim();

    // default to Global
    var tenantIdRegEx = /^https:\/\/login\.microsoftonline\.(?:us|com)\/([\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12})\/oauth2\/authorize$/;
    var lookupUrl = "https://login.microsoftonline.us/" + tenant + "/.well-known/openid-configuration";

    // change the lookup destination based on the environment dropdown.
    switch (lookupEnvironment) {
        case 'Worldwide':
            tenantIdRegEx = /^https:\/\/login\.microsoftonline\.(?:us|com)\/([\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12})\/oauth2\/authorize$/;
            lookupUrl = "https://login.microsoftonline.com/" + tenant + "/.well-known/openid-configuration";
            break;
        case 'US Government':
            tenantIdRegEx = /^https:\/\/login\.microsoftonline\.(?:us|com)\/([\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12})\/oauth2\/authorize$/;
            lookupUrl = "https://login.microsoftonline.us/" + tenant + "/.well-known/openid-configuration";
            break;
        case 'China':
            tenantIdRegEx = /^https:\/\/login\.partner\.microsoftonline\.cn\/([\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12})\/oauth2\/authorize$/;
            lookupUrl = "https://login.partner.microsoftonline.cn/" + tenant + "/.well-known/openid-configuration";
            break;
        case 'Germany':  // deprecated
            tenantIdRegEx = /^https:\/\/login\.microsoftonline\.de\/([\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12})\/oauth2\/authorize$/;
            lookupUrl = "https://login.microsoftonline.de/" + tenant + "/.well-known/openid-configuration";
            break;
        case 'PreProduction':
            tenantIdRegEx = /^https:\/\/login\.windows-ppe\.net\/([\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12})\/oauth2\/authorize$/;
            lookupUrl = "https://login.windows-ppe.net/" + tenant + "/.well-known/openid-configuration";
            break;
        default:
            tenantIdRegEx = /^https:\/\/login\.microsoftonline\.(?:us|com)\/([\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12})\/oauth2\/authorize$/;
            lookupUrl = "https://login.microsoftonline.com/" + tenant + "/.well-known/openid-configuration";
    }

    xmlhttp.open("GET", lookupUrl, true);
    xmlhttp.onload = function () {
        if (xmlhttp.status == 200) {
            try {
                var myObj = JSON.parse(this.responseText);

                // extract the tenant ID
                var tenantAuthEndpoint = myObj.authorization_endpoint;
                var tenantId = tenantAuthEndpoint.match(tenantIdRegEx);
                document.getElementById("tenantId").innerHTML = tenantId[1];

                // figure out which tenant partition this thing is in
                var tenantRegion = "Unknown";

                switch (myObj.tenant_region_scope) {
                    case 'USGov':
                        tenantRegion = "Azure AD Government: Arlington";
                        infoBox.show();
                        fairfaxMigrationBlurb.show();
                        $('#azureADInstance').addClass("bg-light");
                        break;
                    case 'USG':
                        tenantRegion = "Azure AD Government: Fairfax";
                        infoBox.show();
                        fairfaxMigrationBlurb.show();
                        $('#azureADInstance').addClass("bg-light");
                        break;
                    case 'WW':
                        tenantRegion = "Azure AD Global";
                        break;
                    case 'NA':
                        tenantRegion = "Azure AD Global: North America";
                        break;
                    case 'EU':
                        tenantRegion = "Azure AD Global: Europe";
                        break;
                    case 'AS':
                        if (lookupEnvironment == 'China') {
                            tenantRegion = "Azure AD China"
                        }
                        else {
                            tenantRegion = "Azure AD Global: Asia-Pacific";
                        }
                        break;
                    case 'OC':
                        tenantRegion = "Azure AD Global: Oceania";
                        break;
                    case 'SA':
                        tenantRegion = "Azure AD Global: South America";
                        break;
                    case 'DE':
                        tenantRegion = "Azure AD Germany";
                        break;
                    default:
                        tenantRegion = "Other (most likely Azure AD Global)";
                }

                document.getElementById("tenantPartition").innerHTML = tenantRegion;

                // is this a GCC High or DOD tenant?
                var tenantScope = "";
                switch (myObj.tenant_region_sub_scope) {
                    case 'DOD':
                        tenantScope = "DOD";
                        break;
                    case 'DODCON':
                        tenantScope = "GCC High";
                        break;
                    case 'GCC':
                        tenantScope = "GCC";
                        break;
                    default:
                        if (tenantRegion == "USGOV") {
                            tenantScope = "Untagged";
                        }
                        else {
                            tenantScope = "Not applicable";
                        }
                }


                document.getElementById("tenantClass").innerHTML = tenantScope;

                // is this GCC in Azure Government?
                if (myObj.tenant_region_sub_scope == 'GCC' && (myObj.tenant_region_scope == "USG" || myObj.tenant_region_scope == "USGov")) {
                    ShowGCCInGovWarning();
                }

                // is this GCC High or DOD in Azure Global?
                if ((myObj.tenant_region_sub_scope == 'DODCON' || myObj.tenant_region_sub_scope == 'DOD') && (myObj.tenant_region_scope != "USG" && myObj.tenant_region_scope != "USGov")) {
                    ShowGCCHInGovWarning();
                }

                try {
                        fetch(`api?tenantId=${tenantId[1]}`).then(res => res.json()).then(data => {
                        document.getElementById("tenantName").innerHTML = data.displayName;
                        document.getElementById("tenantDomain").innerHTML = data.defaultDomainName;
                        document.getElementById("tenantFederation").innerHTML = data.federationBrandName || "Not applicable";

                        // build the plaintext version
                        plainTextResults = "Tenant Name: " + data.displayName + "\nTenant Domain: " + data.defaultDomainName + "\nTenant GUID: " + tenantId[1] + "\nAzure AD Instance: " + tenantRegion + "\nTenant Scope: " + tenantScope + "\nTenant Federation: " + (data.federationBrandName || "Not applicable");
                    })
                } catch (e) {} finally {
                    lookupResults.show();
                    spinner.hide();
                }
            }
            catch (error) {
                console.error(error)
                plainTextResults = "";
                lookupError.show();
                lookupResults.hide();
                spinner.hide();
            }
        }
        if (xmlhttp.status == 400) {
            plainTextResults = "";
            lookupError.show();
            lookupResults.hide();
            spinner.hide();
        }
    };

    xmlhttp.onerror = function () {
        plainTextResults = "";
        lookupError.show();
        lookupResults.hide();
        spinner.hide();
    };

    xmlhttp.send();

};

function ResetView() {
    infoBox.hide();
    errorGccTenantInGov.hide();
    fairfaxMigrationBlurb.hide();
    lookupError.hide();

    tenantPartitionRow.removeClass();
    tenantClassRow.removeClass();
};

function ShowGCCInGovWarning() {
    // show the dumpster fire warning
    infoBox.show();
    errorGccTenantInGov.show();
    fairfaxMigrationBlurb.hide();

    // make the text red if we run into this.
    tenantPartitionRow.addClass("table-danger");
    tenantClassRow.addClass("table-danger");

};

function ShowGCCHInGovWarning() {
    // show the dumpster fire warning
    infoBox.show();
    errorGccHTenantInGov.show();
    fairfaxMigrationBlurb.hide();

    // make the text red if we run into this.
    tenantPartitionRow.addClass("table-danger");
    tenantClassRow.addClass("table-danger");

};
