namespace MsftUpdates.Sync;

/// <summary>
/// Bounds the XML held between download and write. One update can be 140 MB as a string, so a count of
/// updates in flight bounds nothing.
/// </summary>
internal sealed class ByteBudget(long bytes)
{
    private const int Unit = 1 << 20;

    private readonly int _units = (int)Math.Max(1, bytes / Unit);
    private readonly SemaphoreSlim _available = new((int)Math.Max(1, bytes / Unit));
    private readonly SemaphoreSlim _acquiring = new(1, 1);

    /// <summary>Waits for <paramref name="bytes"/>, or the whole budget if it asks for more, and returns how many units to release.</summary>
    public async Task<int> AcquireAsync(long bytes, CancellationToken ct)
    {
        var units = (int)Math.Clamp((bytes + Unit - 1) / Unit, 1, _units);
        // one caller gathers units at a time, so two large ones can't each hold half the budget
        await _acquiring.WaitAsync(ct);
        try
        {
            for (var i = 0; i < units; i++)
            {
                await _available.WaitAsync(ct);
            }
        }
        finally
        {
            _acquiring.Release();
        }
        return units;
    }

    public void Release(int units) => _available.Release(units);
}
