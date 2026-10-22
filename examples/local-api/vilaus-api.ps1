# Calls Vilausity's local API (docs/local-api.md) from PowerShell, Windows PowerShell 5.1 too.
# Load it into the session, then call operations by name:
#
#   . .\vilaus-api.ps1
#   Invoke-Vilaus windows.list
#   Invoke-Vilaus conversations.open @{ prompt = 'Why does the build fail?' }
#   Invoke-Vilaus files.open @{ path = 'C:\project\README.md'; line = 10 }
#   Invoke-Vilaus commands.run @{ command = 'sessions.toggleSidebar' }
#   Invoke-Vilaus conversations.send @{ prompt = 'Run the tests' }   # needs "Allow sending" on
#
# Turn the local API on first (Settings > Local API). The administrator instance's file is
# admin\api.json: pass -Administrator. Another instance's (a dev instance): $env:VILAUS_API_FILE.

function Get-VilausApi {
    param([switch]$Administrator)
    $folder = Join-Path $env:APPDATA 'Vilausity'
    if ($Administrator) { $folder = Join-Path $folder 'admin' }
    $file = Join-Path $folder 'api.json'
    if ($env:VILAUS_API_FILE -and -not $Administrator) { $file = $env:VILAUS_API_FILE }
    if (-not (Test-Path $file)) { throw "No $file : turn the local API on in Vilausity's settings first." }
    # Read as UTF-8 whatever the console's code page.
    [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Invoke-Vilaus {
    param(
        [Parameter(Mandatory = $true, Position = 0)][string]$Name,
        [Parameter(Position = 1)][hashtable]$Params = @{},
        [switch]$Administrator
    )
    $api = Get-VilausApi -Administrator:$Administrator
    $headers = @{ Authorization = "Bearer $($api.token)" }
    # Windows PowerShell 5.1 would send a string body in another encoding: send UTF-8 bytes.
    $body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $Params -Depth 10 -Compress))
    try {
        Invoke-RestMethod -Uri "$($api.url)/$Name" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
    } catch {
        # The API says what went wrong in the body: {"error": ..., "message": ...}.
        $response = $_.Exception.Response
        if ($response) {
            throw "Vilausity: $([int]$response.StatusCode) $($_.ErrorDetails.Message)"
        }
        throw
    }
}
