using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Mime;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using StoreWeb.Models;
using StoreLib.Models;
using StoreLib.Services;

namespace StoreWeb.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class DownloadController : ControllerBase
    {
        private static readonly MSHttpClient _httpClient = new MSHttpClient();

        // GET: api/Download
        [HttpGet]
        public async Task<IActionResult> GetDownload(
            /*Mandatory get parameter*/ string Id,
            string Idtype = "url",
            string Environment = "Production",
            string Market = "US",
            string Lang = "en",
            string Msatoken = null,
            string Name = null,
            string Arch = null,
            string Architecture = null)
        {
            Arch ??= Architecture;
            if (string.IsNullOrWhiteSpace(Id))
            {
                return BadRequest("Missing ID");
            }
            if (!Enum.TryParse(Environment, true, out DCatEndpoint environment)
                || !Enum.TryParse(Lang, true, out Lang lang)
                || !Enum.TryParse(Market, true, out Market market))
            {
                return BadRequest("Unknown environment, market or language");
            }
            Packages packagerequest = new Packages()
            {
                id = Id.Trim(),
                environment = environment,
                lang = lang,
                market = market,
                msatoken = Msatoken
            };
            switch (Idtype)
            {
                case "url":
                    var match = new Regex(@"[a-zA-Z0-9]{12}").Match(packagerequest.id);
                    if (!match.Success)
                    {
                        return BadRequest("No product ID found in the URL");
                    }
                    packagerequest.id = match.Value;
                    packagerequest.type = IdentiferType.ProductID;
                    break;
                case "productid":
                    packagerequest.type = IdentiferType.ProductID;
                    break;
                case "pfn":
                    packagerequest.type = IdentiferType.PackageFamilyName;
                    break;
                case "cid":
                    packagerequest.type = IdentiferType.ContentID;
                    break;
                case "xti":
                    packagerequest.type = IdentiferType.XboxTitleID;
                    break;
                case "lxpi":
                    packagerequest.type = IdentiferType.LegacyXboxProductID;
                    break;
                case "lwspi":
                    packagerequest.type = IdentiferType.LegacyWindowsStoreProductID;
                    break;
                case "lwppi":
                    packagerequest.type = IdentiferType.LegacyWindowsPhoneProductID;
                    break;
                default:
                    if (!Enum.TryParse(Idtype, true, out IdentiferType idtype))
                    {
                        return BadRequest("Unknown ID type");
                    }
                    packagerequest.type = idtype;
                    break;
            }
            DisplayCatalogHandler dcat = new DisplayCatalogHandler(packagerequest.environment, new Locale(packagerequest.market, packagerequest.lang, true));
            if (!string.IsNullOrWhiteSpace(packagerequest.msatoken))
            {
                await dcat.QueryDCATAsync(packagerequest.id, packagerequest.type, packagerequest.msatoken);
            }
            else
            {
                await dcat.QueryDCATAsync(packagerequest.id, packagerequest.type);
            }
            if (!dcat.IsFound)
            {
                return NotFound("Product not found");
            }
            dcat.ProductListing.Product ??= dcat.ProductListing.Products?.FirstOrDefault();
            var mainPackage = dcat.ProductListing.Product?.DisplaySkuAvailabilities?.FirstOrDefault()?.Sku?.Properties?.Packages?.FirstOrDefault();
            if (mainPackage == null)
            {
                return NotFound("Product has no downloadable packages");
            }
            var productpackages = await dcat.GetPackagesForProductAsync();

            if (!string.IsNullOrWhiteSpace(Name))
            {
                var package = productpackages.FirstOrDefault(p => MonikerMatches(p.PackageMoniker, Name, Arch));
                if (package == null)
                {
                    return NotFound("No package matches that name and architecture");
                }
                return Redirect(package.PackageUri.ToString());
            }

            List<PackageInstance> candidates = new List<PackageInstance>();
            string pfn = mainPackage.PackageFamilyName;
            if (!string.IsNullOrEmpty(pfn) && pfn.Contains('_'))
            {
                int separator = pfn.LastIndexOf('_');
                string name = pfn.Substring(0, separator);
                string publisher = pfn.Substring(separator + 1);
                candidates = productpackages
                    .Where(p => p.PackageMoniker.StartsWith(name + "_", StringComparison.OrdinalIgnoreCase)
                        && p.PackageMoniker.EndsWith("_" + publisher, StringComparison.OrdinalIgnoreCase))
                    .ToList();
            }
            Uri downloadUri = null;
            int bestRank = int.MinValue;
            foreach (PackageInstance candidate in candidates)
            {
                int rank = RankInstallFile(await GetDownloadFileNameAsync(candidate.PackageUri));
                if (rank > bestRank)
                {
                    bestRank = rank;
                    downloadUri = candidate.PackageUri;
                }
            }
            if (downloadUri == null && mainPackage.PackageDownloadUris?.Count > 0)
            {
                downloadUri = new Uri(mainPackage.PackageDownloadUris[0].Uri);
            }
            if (downloadUri == null)
            {
                return NotFound("Product has no downloadable packages");
            }
            if (!string.IsNullOrEmpty(mainPackage.Version))
            {
                Response.Headers["x-ms-meta-version"] = mainPackage.Version;
            }
            return Redirect(downloadUri.ToString());
        }

        private static bool MonikerMatches(string moniker, string name, string arch)
        {
            if (string.IsNullOrEmpty(moniker))
            {
                return false;
            }
            string[] parts = moniker.Split('_');
            if (parts.Length < 3)
            {
                return false;
            }
            if (!parts[0].Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            return string.IsNullOrWhiteSpace(arch) || parts[2].Equals(arch, StringComparison.OrdinalIgnoreCase);
        }

        private static async Task<string> GetDownloadFileNameAsync(Uri uri)
        {
            HttpRequestMessage httpRequest = new HttpRequestMessage();
            httpRequest.RequestUri = uri;
            httpRequest.Method = HttpMethod.Head;
            httpRequest.Headers.Add("Connection", "Keep-Alive");
            httpRequest.Headers.Add("Accept", "*/*");
            httpRequest.Headers.Add("User-Agent", "Microsoft-Delivery-Optimization/10.0");
            HttpResponseMessage httpResponse = await _httpClient.SendAsync(httpRequest, new CancellationToken());
            if (httpResponse.Content.Headers.TryGetValues("Content-Disposition", out var values))
            {
                return new ContentDisposition(values.First()).FileName;
            }
            return null;
        }

        private static int RankInstallFile(string fileName)
        {
            if (string.IsNullOrEmpty(fileName))
            {
                return 0;
            }
            string lower = fileName.ToLowerInvariant();
            if (lower.EndsWith(".appxbundle") || lower.EndsWith(".msixbundle"))
            {
                return 4;
            }
            if (lower.EndsWith(".appx") || lower.EndsWith(".msix"))
            {
                return 3;
            }
            if (lower.EndsWith(".eappxbundle") || lower.EndsWith(".emsixbundle"))
            {
                return 2;
            }
            if (lower.EndsWith(".eappx") || lower.EndsWith(".emsix"))
            {
                return 1;
            }
            return 0;
        }
    }
}
