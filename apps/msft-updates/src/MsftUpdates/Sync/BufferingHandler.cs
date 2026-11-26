namespace MsftUpdates.Sync;

/// <summary>
/// Reads each response body inside its attempt, so the attempt timeout and retries also cover a body
/// that stops arriving. The XML reader reads synchronously, and a stalled stream would block it forever.
/// </summary>
internal sealed class BufferingHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var response = await base.SendAsync(request, cancellationToken);
        try
        {
            await response.Content.LoadIntoBufferAsync(cancellationToken);
            return response;
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }
}
