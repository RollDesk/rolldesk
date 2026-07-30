<#
.SYNOPSIS
  Reports deployment progress to RollDesk over the automation API.

.DESCRIPTION
  A ready-to-run wrapper around PATCH /api/deployments/:id for the common cases
  an installation script needs: report progress, close a rollout, mark a single
  target installed or failed, pause, or attach notes.

  Why this exists rather than a bare Invoke-RestMethod: the endpoint takes the
  deployment's stored field names, and which field applies depends on whether
  the record is single-target or multi-target ("batch"). A batch rollout shows
  no status at all — its progress bar is derived from counts.scheduled reaching
  zero. Sending {"status":"installed"} to a batch record therefore looks like it
  worked (the timeline records it) while the row keeps showing "312/400". This
  script reads the record first and sends the field that actually applies.

  Set RD_TOKEN in the environment instead of passing -Token on the command line,
  so the token does not land in the shell history or in a CI job log.

.PARAMETER BaseUrl
  RollDesk address, e.g. https://rolldesk.example.com (nginx, not the API port).

.PARAMETER Id
  Deployment id, e.g. DEP-2026-0047.

.PARAMETER Token
  Personal access token (rd_live_…). Defaults to $env:RD_TOKEN.

.PARAMETER Installed
  Multi-target: how many targets are done. Combined with -Remaining, or with the
  record's own total when -Remaining is omitted.

.PARAMETER Remaining
  Multi-target: how many targets are still pending.

.PARAMETER Complete
  Close the deployment: a single target becomes 'installed'; a batch rollout has
  everything still pending moved to installed and its pending queue emptied.

.PARAMETER Status
  Single-target status: scheduled, installed, failed, rolledback, aborted.

.PARAMETER Pause / -Resume
  Pause or resume the distribution. A pause is not a status — the deployment
  keeps the one it had. -Pause takes -Reason.

.PARAMETER Notes
  Replace the deployer instructions shown in the deployer panel.

.PARAMETER Changelog
  Replace the release description shown on the deployment and in notifications.

.PARAMETER AssignedTo
  Name of the deployer carrying it out (must match a RollDesk account name).

.PARAMETER WhatIf
  Print the request that would be sent and exit without sending it.

.EXAMPLE
  # Progress of a rollout: 312 of 400 done
  .\Update-RollDeskDeployment.ps1 -BaseUrl https://rolldesk.example.com `
      -Id DEP-2026-0047 -Installed 312 -Remaining 88

.EXAMPLE
  # Today's batch finished the last targets — close the rollout
  .\Update-RollDeskDeployment.ps1 -BaseUrl https://rolldesk.example.com `
      -Id DEP-2026-0047 -Complete

.EXAMPLE
  # A single-target deployment failed
  .\Update-RollDeskDeployment.ps1 -BaseUrl https://rolldesk.example.com `
      -Id DEP-2026-0051 -Status failed

.EXAMPLE
  # Pause with a reason, then resume
  .\Update-RollDeskDeployment.ps1 -BaseUrl https://rolldesk.example.com -Id DEP-2026-0047 `
      -Pause -Reason "Client asked to hold until Monday"
  .\Update-RollDeskDeployment.ps1 -BaseUrl https://rolldesk.example.com -Id DEP-2026-0047 -Resume

.EXAMPLE
  # Typical end of an installer script: fail the run if RollDesk was not updated
  $ErrorActionPreference = 'Stop'
  .\Update-RollDeskDeployment.ps1 -BaseUrl $env:RD_URL -Id $env:RD_DEPLOYMENT -Complete
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string] $BaseUrl,
  [Parameter(Mandatory = $true)][string] $Id,
  [string] $Token = $env:RD_TOKEN,

  [int]    $Installed = -1,
  [int]    $Remaining = -1,
  [switch] $Complete,
  [ValidateSet('scheduled', 'installed', 'failed', 'rolledback', 'aborted')]
  [string] $Status,
  [switch] $Pause,
  [switch] $Resume,
  [string] $Reason,
  [string] $Notes,
  [string] $Changelog,
  [string] $AssignedTo
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "No token. Set `$env:RD_TOKEN to an rd_live_… token, or pass -Token."
}
if ($Token -notlike 'rd_live_*') {
  Write-Warning "The token does not start with 'rd_live_' — RollDesk personal access tokens do."
}

$base    = $BaseUrl.TrimEnd('/')
$uri     = "$base/api/deployments/$Id"
$headers = @{ Authorization = "Bearer $Token" }

# TLS 1.2 for Windows PowerShell 5.1, whose default is too old for many servers.
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Invoke-RollDesk {
  param([string] $Method, [string] $Uri, $Body)
  # Not $args — that is an automatic variable and assigning to it is a trap.
  $req = @{ Method = $Method; Uri = $Uri; Headers = $headers; ErrorAction = 'Stop' }
  if ($null -ne $Body) {
    # -Depth 10: the deployment object nests (counts, apps, dayPlan), and the
    # default of 2 silently truncates nested values into "System.Object[]".
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Body        = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }
  try {
    return Invoke-RestMethod @req
  } catch {
    # Surface the API's own message; the bare status line is rarely enough.
    $detail = $null
    $resp   = $_.Exception.Response
    if ($resp) {
      try {
        if ($PSVersionTable.PSVersion.Major -ge 6) {
          $detail = $_.ErrorDetails.Message
        } else {
          $reader = New-Object IO.StreamReader($resp.GetResponseStream())
          $detail = $reader.ReadToEnd()
        }
      } catch { }
    }
    if ($detail) { throw "$Method $Uri failed: $detail" }
    throw
  }
}

# Read the record first: whether progress belongs in `counts` or in `status`
# depends on its mode, and guessing wrong writes a field nothing reads.
Write-Verbose "Reading $uri"
$dep = Invoke-RollDesk -Method Get -Uri $uri
if (-not $dep) { throw "Deployment $Id not found at $base." }

$isBatch = ($dep.mode -eq 'batch')
$total   = if ($dep.totalLocations) { [int] $dep.totalLocations } else { 0 }
Write-Verbose ("Mode: {0}{1}" -f $dep.mode, $(if ($isBatch) { " ($total targets)" } else { '' }))

$patch = @{}

if ($Installed -ge 0 -or $Remaining -ge 0) {
  if (-not $isBatch) {
    throw "$Id is a single-target deployment — it has no counts. Use -Status or -Complete."
  }
  $done = if ($Installed -ge 0) { $Installed } else { [int] $dep.counts.installed }
  $left = if ($Remaining -ge 0) {
    $Remaining
  } elseif ($total -gt 0) {
    # Derive the remainder from the record's own total rather than assuming one.
    [Math]::Max(0, $total - $done)
  } else {
    throw "Pass -Remaining: $Id does not record a target total to derive it from."
  }
  if ($total -gt 0 -and ($done + $left) -ne $total) {
    Write-Warning "installed + remaining = $($done + $left), but the deployment has $total targets."
  }
  # The whole object replaces the stored one (the merge is shallow per key), so
  # both halves must be present — sending only `installed` drops `scheduled`.
  $patch.counts = @{ installed = $done; scheduled = $left }
}

if ($Complete) {
  # Same field either way: for a batch record the backend expands this into
  # closing the rollout (everything pending moves to installed, the pending
  # queue is emptied); see README "Multi-target rollouts".
  $patch.status = 'installed'
}

if ($Status) {
  if ($isBatch -and -not $Complete) {
    Write-Warning "$Id is a batch rollout — its progress comes from counts, not status. Use -Installed/-Remaining for partial progress, or -Complete to close it."
  }
  $patch.status = $Status
}

if ($Pause -and $Resume) { throw 'Pass either -Pause or -Resume, not both.' }
if ($Pause) {
  $patch.paused = $true
  if ($Reason) { $patch.pauseReason = $Reason }
}
if ($Resume) {
  $patch.paused      = $false
  $patch.pauseReason = ''
}

if ($PSBoundParameters.ContainsKey('Notes'))      { $patch.installerNotes = $Notes }
if ($PSBoundParameters.ContainsKey('Changelog'))  { $patch.changelog      = $Changelog }
if ($PSBoundParameters.ContainsKey('AssignedTo')) { $patch.assignedTo     = $AssignedTo }

if ($patch.Count -eq 0) {
  throw 'Nothing to change. Pass -Installed/-Remaining, -Complete, -Status, -Pause/-Resume, -Notes, -Changelog or -AssignedTo.'
}

$json = $patch | ConvertTo-Json -Depth 10 -Compress
Write-Verbose "PATCH $uri $json"

if (-not $PSCmdlet.ShouldProcess($Id, "PATCH $json")) { return }

$result = Invoke-RollDesk -Method Patch -Uri $uri -Body $patch

# Report what RollDesk actually stored, not what was sent — the batch expansion
# means the two differ by design.
if ($result.counts) {
  $installedNow = [int] $result.counts.installed
  $leftNow      = [int] $result.counts.scheduled
  Write-Host ("{0}: {1}/{2} installed, {3} left{4}" -f `
    $Id, $installedNow, ($installedNow + $leftNow), $leftNow,
    $(if ($result.paused) { ' (paused)' } else { '' }))
} else {
  Write-Host ("{0}: {1}{2}" -f $Id, $result.status, $(if ($result.paused) { ' (paused)' } else { '' }))
}

$result
