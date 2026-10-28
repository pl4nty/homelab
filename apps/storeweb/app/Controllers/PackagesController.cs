using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Linq.Expressions;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StoreWeb.Data;
using StoreWeb.Models;
using StoreLib.Models;
using StoreLib.Services;
using StoreLib.Utilities;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using System.Net.Mime;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;

namespace StoreWeb.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class PackagesController : ControllerBase
    {
        private static readonly MSHttpClient _httpClient = new MSHttpClient();

        private readonly StoreWebContext _context;

        public PackagesController(StoreWebContext context)
        {
            _context = context;
        }

        // GET: api/Packages
        [HttpGet]
        public async Task<string> GetPackages(
            /*Mandatory get parameter*/ string Id,
            string Idtype="url",
            string Environment="Production",
            string Market = "US",
            string Lang = "en",
            string Msatoken=null)
        {
            Packages packagerequest = new Packages()
            {
                id = Id,
                environment = (DCatEndpoint)Enum.Parse(typeof(DCatEndpoint), Environment),
                lang = (Lang)Enum.Parse(typeof(Lang), Lang),
                market = (Market)Enum.Parse(typeof(Market), Market),
                msatoken = Msatoken
            };
            switch (Idtype)
            {
                case "url":
                    packagerequest.id = new Regex(@"[a-zA-Z0-9]{12}").Matches(packagerequest.id)[0].Value;
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
                    packagerequest.type = (IdentiferType)Enum.Parse(typeof(IdentiferType),Idtype);
                    break;
            }
            DisplayCatalogHandler dcat = new DisplayCatalogHandler(packagerequest.environment, new Locale(packagerequest.market, packagerequest.lang, true));
            if (!string.IsNullOrWhiteSpace(packagerequest.msatoken)) {
                await dcat.QueryDCATAsync(packagerequest.id, packagerequest.type, packagerequest.msatoken);
            }
            else 
            {
                await dcat.QueryDCATAsync(packagerequest.id, packagerequest.type);
            }
            List<PackageInfo> packages = new List<PackageInfo>();
            var productpackages = await dcat.GetPackagesForProductAsync();
            List<Task<HttpResponseMessage>> httpTasks = new List<Task<HttpResponseMessage>>();
            //iterate through all packages
            foreach (PackageInstance package in productpackages)
            {
                var temppackageinfo = new PackageInfo()
                {
                    packagedownloadurl = package.PackageUri.ToString(),
                    packagemoniker = package.PackageMoniker
                };
                HttpRequestMessage httpRequest = new HttpRequestMessage();
                httpRequest.RequestUri = package.PackageUri;
                //httpRequest.Method = HttpMethod.Get;
                httpRequest.Method = HttpMethod.Head;
                httpRequest.Headers.Add("Connection", "Keep-Alive");
                httpRequest.Headers.Add("Accept", "*/*");
                //httpRequest.Headers.Add("Range", "bytes=0-1");
                httpRequest.Headers.Add("User-Agent", "Microsoft-Delivery-Optimization/10.0");
                httpTasks.Add(_httpClient.SendAsync(httpRequest, new System.Threading.CancellationToken()));
                packages.Add(temppackageinfo);
            }
            if (!object.ReferenceEquals(dcat.ProductListing.Product.DisplaySkuAvailabilities[0].Sku.Properties.Packages[0].PackageDownloadUris, null))
            {
                foreach (var Package in dcat.ProductListing.Product.DisplaySkuAvailabilities[0].Sku.Properties.Packages[0].PackageDownloadUris)
                {
                    Uri PackageURL = new Uri(Package.Uri);
                    PackageInfo temppackageinfo = new PackageInfo()
                    {
                        packagedownloadurl = Package.Uri,
                        packagemoniker = PackageURL.Segments[PackageURL.Segments.Length - 1],
                        packagefilename = PackageURL.Segments[PackageURL.Segments.Length - 1]
                    };
                    HttpRequestMessage httpRequest = new HttpRequestMessage();
                    httpRequest.RequestUri = PackageURL;
                    //httpRequest.Method = HttpMethod.Get;
                    httpRequest.Method = HttpMethod.Head;
                    httpRequest.Headers.Add("Connection", "Keep-Alive");
                    httpRequest.Headers.Add("Accept", "*/*");
                    //httpRequest.Headers.Add("Range", "bytes=0-1");
                    httpRequest.Headers.Add("User-Agent", "Microsoft-Delivery-Optimization/10.0");
                    httpTasks.Add(_httpClient.SendAsync(httpRequest, new System.Threading.CancellationToken()));
                    packages.Add(temppackageinfo);
                }
            }
            HttpResponseMessage[] httpResponses = await Task.WhenAll(httpTasks);
            for (int i = 0; i < httpResponses.Length; i++)
            {
                HttpResponseMessage httpResponse = httpResponses[i];
                HttpHeaders headers = httpResponse.Content.Headers;
                IEnumerable<string> values;
                if (headers.TryGetValues("Content-Disposition", out values))
                {
                    ContentDisposition contentDisposition = new ContentDisposition(values.First());
                    packages[i].packagefilename = contentDisposition.FileName;
                }
                if (headers.TryGetValues("Content-Length", out values))
                {
                    packages[i].packagefilesize = Convert.ToInt64(values.FirstOrDefault());
                }
            }
            return JsonConvert.SerializeObject(packages);
        }


        private bool PackageRequestExists(string id)
        {
            return _context.PackageRequest.Any(e => e.id == id);
        }
    }
}
