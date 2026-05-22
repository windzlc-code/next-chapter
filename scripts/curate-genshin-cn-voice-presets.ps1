[CmdletBinding()]
param(
    [string]$SourceRoot = '',
    [string]$OutputRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptPath = if ($PSScriptRoot) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
$repoRoot = (Resolve-Path (Join-Path $scriptPath '..')).Path
if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Join-Path $repoRoot 'genshin-cn-voice-presets-v2'
}
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot 'genshin-cn-voice-presets-merged'
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $text = [System.IO.File]::ReadAllText($Path)
    $text = $text.TrimStart([char]0xFEFF)
    return $text | ConvertFrom-Json
}

function Ensure-DirectoryPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string[]]$Segments
    )

    $path = $Root
    foreach ($segment in $Segments) {
        $path = Join-Path $path $segment
        if (-not (Test-Path -LiteralPath $path)) {
            $null = New-Item -ItemType Directory -Path $path
        }
    }

    return $path
}

$sourceSummaryPath = Join-Path $SourceRoot 'summary.json'
$sourceManifestPath = Join-Path $SourceRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $sourceSummaryPath)) {
    throw "Missing source summary: $sourceSummaryPath"
}
if (-not (Test-Path -LiteralPath $sourceManifestPath)) {
    throw "Missing source manifest: $sourceManifestPath"
}

$null = Read-JsonFile -Path $sourceSummaryPath
$sourceManifest = Read-JsonFile -Path $sourceManifestPath

$keptCategories = @(
    [pscustomobject]@{ NewId='C01'; SourceId='B_F01'; GroupPath=@('base', 'female'); FolderName='01_loli_bright'; Title='Loli Bright'; Description='High-pitched, bright, sprite-like.' },
    [pscustomobject]@{ NewId='C02'; SourceId='B_F02'; GroupPath=@('base', 'female'); FolderName='02_soft_childlike'; Title='Soft Childlike'; Description='Soft, airy, cute, healing.' },
    [pscustomobject]@{ NewId='C03'; SourceId='B_F03'; GroupPath=@('base', 'female'); FolderName='03_girl_energetic'; Title='Girl Energetic'; Description='Young, bright, lively, everyday.' },
    [pscustomobject]@{ NewId='C04'; SourceId='B_F05'; GroupPath=@('base', 'female'); FolderName='04_girl_cool'; Title='Girl Cool'; Description='Cool, thin, restrained.' },
    [pscustomobject]@{ NewId='C05'; SourceId='B_F07'; GroupPath=@('base', 'female'); FolderName='05_woman_cold_sharp'; Title='Woman Cold Sharp'; Description='Cold, sharp, low-temperature pressure.' },
    [pscustomobject]@{ NewId='C06'; SourceId='B_F08'; GroupPath=@('base', 'female'); FolderName='06_woman_lazy_magnetic'; Title='Woman Lazy Magnetic'; Description='Heavier chest voice, relaxed, mature magnetism.' },
    [pscustomobject]@{ NewId='C07'; SourceId='B_M02'; GroupPath=@('base', 'male'); FolderName='07_boy_gentle_bookish'; Title='Boy Gentle Bookish'; Description='Bookish, gentle, soft-spoken.' },
    [pscustomobject]@{ NewId='C08'; SourceId='B_M03'; GroupPath=@('base', 'male'); FolderName='08_boy_cold_thin'; Title='Boy Cold Thin'; Description='Cold, thin, sharp, restrained.' },
    [pscustomobject]@{ NewId='C09'; SourceId='B_M04'; GroupPath=@('base', 'male'); FolderName='09_man_warm_intellectual'; Title='Man Warm Intellectual'; Description='Rational, warm, smooth, thoughtful.' },
    [pscustomobject]@{ NewId='C10'; SourceId='B_M05'; GroupPath=@('base', 'male'); FolderName='10_man_steady_authority'; Title='Man Steady Authority'; Description='Mature, weighty, authoritative.' },
    [pscustomobject]@{ NewId='C11'; SourceId='B_M06'; GroupPath=@('base', 'male'); FolderName='11_man_rogue_tension'; Title='Man Rogue Tension'; Description='Outward, provocative, cocky.' },
    [pscustomobject]@{ NewId='C12'; SourceId='S02'; GroupPath=@('state'); FolderName='12_elder_authority'; Title='Elder Authority'; Description='Narrative authority, older and calmer.' },
    [pscustomobject]@{ NewId='C13'; SourceId='S03'; GroupPath=@('state'); FolderName='13_villain_cold'; Title='Villain Cold'; Description='Cold, threatening, manipulative.' },
    [pscustomobject]@{ NewId='C14'; SourceId='S04'; GroupPath=@('state'); FolderName='14_worldly_slick'; Title='Worldly Slick'; Description='Smooth, worldly, knows the game.' },
    [pscustomobject]@{ NewId='C15'; SourceId='S05'; GroupPath=@('state'); FolderName='15_low_energy'; Title='Low Energy'; Description='Drained, tired, flattened affect.' },
    [pscustomobject]@{ NewId='C16'; SourceId='S06'; GroupPath=@('state'); FolderName='16_sickly_breathy'; Title='Sickly Breathy'; Description='Weak, airy, short of breath.' },
    [pscustomobject]@{ NewId='C17'; SourceId='S08'; GroupPath=@('state'); FolderName='17_street_uncle'; Title='Street Uncle'; Description='Rough, grounded, everyday older guy.' },
    [pscustomobject]@{ NewId='C18'; SourceId='P01'; GroupPath=@('performance'); FolderName='18_theatrical'; Title='Theatrical'; Description='High-performance delivery, stage-like energy.' },
    [pscustomobject]@{ NewId='C19'; SourceId='P02'; GroupPath=@('performance'); FolderName='19_dreamy_airy'; Title='Dreamy Airy'; Description='Airy, floating, distant, dreamlike.' },
    [pscustomobject]@{ NewId='C20'; SourceId='P03'; GroupPath=@('performance'); FolderName='20_anger_burst'; Title='Anger Burst'; Description='Explosive conflict energy.' }
)

if (Test-Path -LiteralPath $OutputRoot) {
    Remove-Item -LiteralPath $OutputRoot -Recurse -Force
}
$null = New-Item -ItemType Directory -Path $OutputRoot

$outManifest = New-Object System.Collections.Generic.List[object]
$outSummaryItems = New-Object System.Collections.Generic.List[object]

foreach ($category in $keptCategories) {
    $entries = @($sourceManifest | Where-Object { $_.category_id -eq $category.SourceId } | Sort-Object saved_path)
    $folderPath = Ensure-DirectoryPath -Root $OutputRoot -Segments ($category.GroupPath + @($category.FolderName))
    $index = 1

    foreach ($entry in $entries) {
        $sourcePath = $entry.saved_path
        if ($sourcePath.StartsWith('.\')) {
            $sourcePath = Join-Path $repoRoot ($sourcePath.Substring(2))
        }
        $sourcePath = $sourcePath -replace '/', '\'
        if (-not (Test-Path -LiteralPath $sourcePath)) {
            throw "Missing source audio: $sourcePath"
        }

        $sourceFileName = [System.IO.Path]::GetFileName($sourcePath)
        $sourceFileName = $sourceFileName -replace '^\d{2}_', ''
        $newFileName = ('{0:D2}_{1}' -f $index, $sourceFileName)
        $destination = Join-Path $folderPath $newFileName
        Copy-Item -LiteralPath $sourcePath -Destination $destination

        $outManifest.Add([pscustomobject]@{
            category_id = $category.NewId
            source_category_id = $category.SourceId
            category_group_path = ($category.GroupPath -join '/')
            category_title = $category.Title
            folder = $category.FolderName
            speaker = $entry.speaker
            type = $entry.type
            transcription = $entry.transcription
            duration_seconds = $entry.duration_seconds
            row_idx = $entry.row_idx
            in_game_filename = $entry.in_game_filename
            source_audio_url = $entry.source_audio_url
            saved_path = $destination
        }) | Out-Null

        $index++
    }

    $outSummaryItems.Add([pscustomobject]@{
        id = $category.NewId
        source_id = $category.SourceId
        group_path = $category.GroupPath
        title = $category.Title
        folder = $category.FolderName
        description = $category.Description
        count = $entries.Count
    }) | Out-Null
}

$summary = [pscustomobject]@{
    source_roots = @(
        (Join-Path $repoRoot 'genshin-cn-voice-presets'),
        (Join-Path $repoRoot 'genshin-cn-voice-presets-v2')
    )
    primary_audio_source = $SourceRoot
    output_root = $OutputRoot
    built_at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    merge_strategy = 'Curated merge with similarity pruning, favoring >=5s verified clips from v2.'
    total_downloaded_files = $outManifest.Count
    category_counts = $outSummaryItems
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputRoot 'summary.json') -Encoding utf8
$outManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputRoot 'manifest.json') -Encoding utf8

$lines = New-Object System.Collections.Generic.List[string]
$null = $lines.Add('# Genshin Chinese Voice Preset Library - Merged Curated Edition')
$null = $lines.Add('')
$null = $lines.Add("- Primary source: $SourceRoot")
$null = $lines.Add("- Built at: $($summary.built_at)")
$null = $lines.Add("- Total files: $($outManifest.Count)")
$null = $lines.Add('- Goal: maximize audible separation between folders and remove near-duplicate timbre groups.')
$null = $lines.Add('')
$null = $lines.Add('## Kept Categories')
$null = $lines.Add('')
foreach ($item in $outSummaryItems) {
    $null = $lines.Add("- [$($item.group_path -join ' / ')] $($item.folder): $($item.count) files")
    $null = $lines.Add("  Description: $($item.description)")
}
$null = $lines.Add('')
$null = $lines.Add('## Notes')
$null = $lines.Add('')
$null = $lines.Add('- This merged edition removes categories that sounded too similar.')
$null = $lines.Add('- Clips were sourced from the verified v2 library so the >=5s rule stays intact.')
$null = $lines.Add('- manifest.json keeps the original source category id for traceability.')

$lines | Set-Content -LiteralPath (Join-Path $OutputRoot 'README.md') -Encoding utf8

Write-Host ''
Write-Host 'Curated merged library complete.'
Write-Host ("Output root: {0}" -f $OutputRoot)
Write-Host ("Files copied: {0}" -f $outManifest.Count)
foreach ($item in $outSummaryItems) {
    Write-Host ("[{0}] {1}: {2}" -f ($item.group_path -join '/'), $item.title, $item.count)
}
