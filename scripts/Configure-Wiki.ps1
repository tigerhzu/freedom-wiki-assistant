# Configure the unpacked extension without Node.js. No network calls are made.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WikiOrigin,
    [string]$OrnithOrigin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-ValidatedOrigin([string]$Value, [string]$Name) {
    $candidate = $Value.Trim()
    $parsed = $null
    if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$parsed) -or
        $parsed.Scheme -ne 'https' -or $parsed.UserInfo -or
        $parsed.Query -or $parsed.Fragment -or $parsed.AbsolutePath -ne '/' -or
        $candidate.Contains('*') -or $candidate.Contains('\') -or
        $candidate -notmatch '^https://[^/?#]+/?$') {
        throw "$Name must be a plain HTTPS origin, for example https://wiki.example.org (no path, credentials, query, or fragment)."
    }
    return $parsed.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
}

$configuredWikiOrigin = Get-ValidatedOrigin $WikiOrigin 'WikiOrigin'
$configuredOrnithOrigin = if ($OrnithOrigin) { Get-ValidatedOrigin $OrnithOrigin 'OrnithOrigin' } else { $null }
$packageRoot = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'manifest.json') -PathType Leaf)) {
    $packageRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'
}
$manifestPath = Join-Path $packageRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Cannot find a built extension. Extract the release ZIP first, or run npm run build in the source project.'
}
$packageRoot = (Resolve-Path -LiteralPath $packageRoot).Path
$manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
$previousWikiMatch = [string]$manifest.content_scripts[0].matches[0]
if ($previousWikiMatch -notmatch '^https://[^/]+/\*$') {
    throw 'The existing Wiki match is not a supported HTTPS origin pattern.'
}
$previousWikiOrigin = $previousWikiMatch.Substring(0, $previousWikiMatch.Length - 2)
$replacements = @(@{ Before = $previousWikiOrigin; After = $configuredWikiOrigin })
$previousOrnithMatch = $null
$ornithCandidates = @($manifest.host_permissions | Where-Object {
    $_ -ne $previousWikiMatch -and $_ -ne 'https://*.openai.azure.com/*' -and $_ -match '^https://[^*/]+/\*$'
})
if ($ornithCandidates.Count -ne 1) {
    throw 'Cannot uniquely identify the Ornith permission. Start from a fresh release ZIP.'
}
$existingOrnithMatch = [string]$ornithCandidates[0]
$previousOrnithOrigin = $existingOrnithMatch.Substring(0, $existingOrnithMatch.Length - 2)
if ($configuredWikiOrigin -eq $previousOrnithOrigin) {
    throw 'Wiki and Ornith must use distinct origins. Start from a fresh release ZIP when swapping origins.'
}
if ($configuredOrnithOrigin) {
    $previousOrnithMatch = $existingOrnithMatch
    if ($configuredWikiOrigin -eq $configuredOrnithOrigin -or $configuredWikiOrigin -eq $previousOrnithOrigin -or $configuredOrnithOrigin -eq $previousWikiOrigin) {
        throw 'Wiki and Ornith must use distinct origins. Start from a fresh release ZIP when swapping origins.'
    }
    $replacements += @{ Before = $previousOrnithOrigin; After = $configuredOrnithOrigin }
}

$wikiMatch = "$configuredWikiOrigin/*"
$manifest.host_permissions = @($manifest.host_permissions | ForEach-Object {
    if ($_ -eq $previousWikiMatch) { $wikiMatch }
    elseif ($previousOrnithMatch -and $_ -eq $previousOrnithMatch) { "$configuredOrnithOrigin/*" }
    else { $_ }
})
foreach ($entry in $manifest.content_scripts) {
    $entry.matches = @($entry.matches | ForEach-Object { if ($_ -eq $previousWikiMatch) { $wikiMatch } else { $_ } })
}
foreach ($entry in $manifest.web_accessible_resources) {
    $entry.matches = @($entry.matches | ForEach-Object { if ($_ -eq $previousWikiMatch) { $wikiMatch } else { $_ } })
}

# Prepare every update before writing. Replace only the exact known origins,
# including trailing boundaries so a similarly named host is never touched.
$pendingWrites = @()
foreach ($asset in Get-ChildItem -LiteralPath $packageRoot -Filter '*.js' -File -Recurse) {
    $before = [IO.File]::ReadAllText($asset.FullName)
    $after = $before
    foreach ($replacement in $replacements) {
        $pattern = [Regex]::Escape($replacement.Before) + '(?=[/"''\s`]|$)'
        $replacementText = [string]$replacement.After
        $after = [Regex]::Replace($after, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacementText })
    }
    if ($after -ne $before) { $pendingWrites += @{ Path = $asset.FullName; Content = $after } }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($update in $pendingWrites) { [IO.File]::WriteAllText($update.Path, $update.Content, $utf8) }
[IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 30) + [Environment]::NewLine), $utf8)
Write-Output "Configured Wiki: $configuredWikiOrigin"
if ($configuredOrnithOrigin) { Write-Output "Configured Ornith: $configuredOrnithOrigin/v1" }
Write-Output "Load or reload this folder in the browser extension manager: $packageRoot"
Write-Output 'Enter AI credentials in the extension settings page. Existing browser settings are kept.'
