[CmdletBinding()]
param(
    [string]$OutputRoot = '',
    [int]$MaxRowsToScan = 30000,
    [int]$PageSize = 100,
    [double]$MinDurationSeconds = 5.0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$scriptPath = if ($PSScriptRoot) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
$repoRoot = (Resolve-Path (Join-Path $scriptPath '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot 'genshin-cn-voice-presets'
}

$DatasetUrl = 'https://huggingface.co/datasets/simon3000/genshin-voice'
$RowsEndpoint = 'https://datasets-server.huggingface.co/rows?dataset=simon3000%2Fgenshin-voice&config=default&split=train&offset={0}&length={1}'
$RunTimestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$FfprobePath = (Get-Command ffprobe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
if ([string]::IsNullOrWhiteSpace($FfprobePath)) {
    throw 'ffprobe is required but was not found in PATH.'
}

function Invoke-JsonRequest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [int]$Retries = 5,
        [int]$DelaySeconds = 2
    )

    for ($attempt = 1; $attempt -le $Retries; $attempt++) {
        try {
            return Invoke-RestMethod -Uri $Uri -TimeoutSec 90
        } catch {
            if ($attempt -eq $Retries) {
                throw
            }
            Start-Sleep -Seconds ($DelaySeconds * $attempt)
        }
    }
}

function Invoke-FileDownload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [Parameter(Mandatory = $true)]
        [string]$Destination,
        [int]$Retries = 3,
        [int]$DelaySeconds = 2
    )

    for ($attempt = 1; $attempt -le $Retries; $attempt++) {
        try {
            Invoke-WebRequest -Uri $Uri -OutFile $Destination -TimeoutSec 120
            return $true
        } catch {
            Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
            if ($attempt -eq $Retries) {
                return $false
            }
            Start-Sleep -Seconds ($DelaySeconds * $attempt)
        }
    }

    return $false
}

function Get-SafeFileSegment {
    param(
        [AllowNull()]
        [string]$Value,
        [int]$MaxLength = 64
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return 'unknown'
    }

    $sanitized = $Value.Trim()
    $sanitized = $sanitized -replace '[\\/:*?"<>|]', '_'
    $sanitized = $sanitized -replace '\s+', '_'
    $sanitized = $sanitized -replace '[#{}''`~!@\$%\^&\(\)\[\];,]', ''
    $sanitized = $sanitized.Trim('._')

    if ([string]::IsNullOrWhiteSpace($sanitized)) {
        $sanitized = 'unknown'
    }

    if ($sanitized.Length -gt $MaxLength) {
        $sanitized = $sanitized.Substring(0, $MaxLength).TrimEnd('._')
    }

    return $sanitized
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

function Get-AudioDurationInfo {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [double]$MinSeconds = 5.0
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "File not found: $Path"
    }

    $raw = & $script:FfprobePath -v error -show_entries format=duration -of default=nw=1:nk=1 -- $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        throw "ffprobe could not read duration: $Path"
    }

    $duration = [double]::Parse($raw.Trim(), [Globalization.CultureInfo]::InvariantCulture)

    return [pscustomobject]@{
        Seconds = $duration
        MeetsMinimum = $duration -ge $MinSeconds
    }
}

function Test-RowMatchesCategory {
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Category,
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Row
    )

    if ($Category.Speakers -notcontains $Row.speaker) {
        return $false
    }

    if ($Category.RowTypes.Count -gt 0 -and $Category.RowTypes -notcontains $Row.type) {
        return $false
    }

    if (-not [string]::IsNullOrWhiteSpace($Category.TextPattern) -and -not [regex]::IsMatch($Row.transcription, $Category.TextPattern)) {
        return $false
    }

    if (-not [string]::IsNullOrWhiteSpace($Category.TextExcludePattern) -and [regex]::IsMatch($Row.transcription, $Category.TextExcludePattern)) {
        return $false
    }

    return $true
}

function Get-NextMatchingCategory {
    param(
        [Parameter(Mandatory = $true)]
        [array]$Categories,
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Row,
        [Parameter(Mandatory = $true)]
        [hashtable]$CategoryCounts,
        [Parameter(Mandatory = $true)]
        [hashtable]$CategorySpeakerCounts
    )

    foreach ($category in $Categories) {
        if ($CategoryCounts[$category.Id] -ge $category.TargetCount) {
            continue
        }

        if (-not (Test-RowMatchesCategory -Category $category -Row $Row)) {
            continue
        }

        $speakerCountTable = $CategorySpeakerCounts[$category.Id]
        if (-not $speakerCountTable.ContainsKey($Row.speaker)) {
            $speakerCountTable[$Row.speaker] = 0
        }

        if ($speakerCountTable[$Row.speaker] -ge $category.MaxPerSpeaker) {
            continue
        }

        return $category
    }

    return $null
}

function Test-AllCategoriesComplete {
    param(
        [Parameter(Mandatory = $true)]
        [array]$Categories,
        [Parameter(Mandatory = $true)]
        [hashtable]$CategoryCounts
    )

    foreach ($category in $Categories) {
        if ($CategoryCounts[$category.Id] -lt $category.TargetCount) {
            return $false
        }
    }

    return $true
}

function Write-VoicePresetReadme {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Destination,
        [Parameter(Mandatory = $true)]
        [array]$Categories,
        [Parameter(Mandatory = $true)]
        [hashtable]$CategoryCounts,
        [Parameter(Mandatory = $true)]
        [int]$RowsScanned,
        [Parameter(Mandatory = $true)]
        [int]$DownloadedFiles,
        [Parameter(Mandatory = $true)]
        [double]$MinDurationSeconds
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $null = $lines.Add('# Genshin Chinese Voice Preset Library')
    $null = $lines.Add('')
    $null = $lines.Add("- Source dataset: $DatasetUrl")
    $null = $lines.Add("- Built at: $RunTimestamp")
    $null = $lines.Add("- Minimum clip duration: $MinDurationSeconds seconds")
    $null = $lines.Add("- Rows scanned from dataset API: $RowsScanned")
    $null = $lines.Add("- Downloaded files: $DownloadedFiles")
    $null = $lines.Add('')
    $null = $lines.Add('## Folder Layout')
    $null = $lines.Add('')

    foreach ($category in $Categories) {
        $count = $CategoryCounts[$category.Id]
        $groupPath = ($category.GroupPath -join ' / ')
        $null = $lines.Add("- [$groupPath] $($category.IndexLabel) $($category.Title): $count / $($category.TargetCount)")
        $null = $lines.Add("  Description: $($category.Description)")
        $null = $lines.Add("  Speaker pool: $($category.Speakers -join ', ')")
    }

    $null = $lines.Add('')
    $null = $lines.Add('## Notes')
    $null = $lines.Add('')
    $null = $lines.Add('- Only rows marked as `Chinese` were used.')
    $null = $lines.Add('- Empty lines and `AnimatorEvent` rows were skipped.')
    $null = $lines.Add('- Every saved clip is at least 5 seconds long, verified with `ffprobe`.')
    $null = $lines.Add('- Base timbre folders are capped at 5 files each.')
    $null = $lines.Add('- `manifest.json` contains per-file metadata, including duration.')

    $lines | Set-Content -LiteralPath $Destination -Encoding utf8
}

$dialogTypes = @('Dialog', 'Fetter', 'Costume', 'DungeonReminder')

$baseCategories = @(
    [pscustomobject]@{ Id='B_F01'; Family='base'; GroupPath=@('基础音色', '女声'); IndexLabel='01'; FolderName='01_萝莉_高音灵动_向导系'; Title='萝莉 高音灵动 向导系'; Description='亮度高，齿音明显，适合小精灵、向导、活泼吉祥物。'; TargetCount=5; MaxPerSpeaker=3; Speakers=@('Paimon', 'Klee', 'Diona', 'Sigewinne'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_F02'; Family='base'; GroupPath=@('基础音色', '女声'); IndexLabel='02'; FolderName='02_幼态软萌_轻气治愈'; Title='幼态软萌 轻气治愈'; Description='奶气、轻气声、柔软，适合陪伴感和童声治愈路线。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Nahida', 'Qiqi', 'Yaoyao', 'Sayu', 'Diona', 'Kachina'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_F03'; Family='base'; GroupPath=@('基础音色', '女声'); IndexLabel='03'; FolderName='03_少女_明亮元气_生活感'; Title='少女 明亮元气 生活感'; Description='开口清脆，节奏轻快，适合日常向、元气向年轻女声。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Xiangling', 'Amber', 'Yoimiya', 'Collei', 'Barbara', 'Kachina', 'Mualani'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_F04'; Family='base'; GroupPath=@('基础音色', '女声'); IndexLabel='04'; FolderName='04_少女_俏皮灵巧_跳脱感'; Title='少女 俏皮灵巧 跳脱感'; Description='俏皮、跳脱、带机灵感，适合古灵精怪和情绪起伏大的角色。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Furina', 'Hu Tao', 'Fischl', 'Yanfei', 'Faruzan', 'Yumemizuki Mizuki'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_F05'; Family='base'; GroupPath=@('基础音色', '女声'); IndexLabel='05'; FolderName='05_少女_清冷通透_收束感'; Title='少女 清冷通透 收束感'; Description='字头干净，尾音克制，适合清冷理性、透明感路线。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Keqing', 'Lynette', 'Layla', 'Ganyu', 'Citlali', 'Chiori'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_F06'; Family='base'; GroupPath=@('基础音色', '女声'); IndexLabel='06'; FolderName='06_成女_端庄优雅_名门感'; Title='成女 端庄优雅 名门感'; Description='优雅、稳定、贵气明显，适合大小姐、名门、得体叙述。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Kamisato Ayaka', 'Ningguang', 'Navia', 'Jean', 'Nilou', 'Emilie'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_F07'; Family='base'; GroupPath=@('基础音色', '女声'); IndexLabel='07'; FolderName='07_成女_冷冽威压_低温感'; Title='成女 冷冽威压 低温感'; Description='低温、锋利、压迫感强，适合御姐、上位者、肃杀路线。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Raiden Shogun', 'Shenhe', 'Rosaria', 'Clorinde', 'The Knave', 'Yelan'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_F08'; Family='base'; GroupPath=@('基础音色', '女声'); IndexLabel='08'; FolderName='08_成女_妩媚知性_慵懒磁性'; Title='成女 妩媚知性 慵懒磁性'; Description='胸声更重，语速从容，适合知性、妩媚、慵懒女声。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Lisa', 'Yae Miko', 'Yelan', 'Beidou', 'Xianyun', 'Dehya'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_M01'; Family='base'; GroupPath=@('基础音色', '男声'); IndexLabel='01'; FolderName='01_少年_清亮元气_自然对白'; Title='少年 清亮元气 自然对白'; Description='音色亮、颗粒轻，适合阳光少年、清爽陪伴和生活化对白。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Bennett', 'Chongyun', 'Mika', 'Gaming', 'Kinich', 'Ororon'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_M02'; Family='base'; GroupPath=@('基础音色', '男声'); IndexLabel='02'; FolderName='02_少年_温柔书卷_轻柔叙述'; Title='少年 温柔书卷 轻柔叙述'; Description='气息柔和，文气明显，适合书卷、吟游、温柔少年路线。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Xingqiu', 'Venti', 'Kaedehara Kazuha', 'Kazuha', 'Lyney', 'Albedo', 'Kaveh'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_M03'; Family='base'; GroupPath=@('基础音色', '男声'); IndexLabel='03'; FolderName='03_少年_锋利冷感_收声明显'; Title='少年 锋利冷感 收声明显'; Description='冷感、锐利、情绪内收，适合寡言、锋利、疏离感男声。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Xiao', 'Wanderer', 'Cyno', 'Heizou', 'Shikanoin Heizou', 'Alhaitham', 'Kinich'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_M04'; Family='base'; GroupPath=@('基础音色', '男声'); IndexLabel='04'; FolderName='04_青年_温润知性_理性稳定'; Title='青年 温润知性 理性稳定'; Description='发声稳定，气息平顺，适合理性、医生、学者、知性男声。'; TargetCount=5; MaxPerSpeaker=3; Speakers=@('Tighnari', 'Baizhu', 'Kamisato Ayato', 'Albedo', 'Kaveh'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_M05'; Family='base'; GroupPath=@('基础音色', '男声'); IndexLabel='05'; FolderName='05_青年_沉稳磁性_权威感'; Title='青年 沉稳磁性 权威感'; Description='中低频更重，成熟稳健，适合领导者、旁白、权威感男声。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Zhongli', 'Neuvillette', 'Diluc', 'Dainsleif', 'Kamisato Ayato'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='B_M06'; Family='base'; GroupPath=@('基础音色', '男声'); IndexLabel='06'; FolderName='06_青年_痞帅张力_攻击性'; Title='青年 痞帅张力 攻击性'; Description='外放、挑衅、张力强，适合反派感、战斗感、痞帅男声。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Childe', 'Tartaglia', 'Arataki Itto', 'Razor', 'Wriothesley', 'Kaeya'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' }
)

$stateCategories = @(
    [pscustomobject]@{ Id='S01'; Family='state'; GroupPath=@('角色状态型'); IndexLabel='01'; FolderName='01_御姐压迫_冷冽审判'; Title='御姐压迫 冷冽审判'; Description='压迫感强，冷、稳、克制，适合御姐、掌权者、审讯感女声。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('The Knave', 'Clorinde', 'Rosaria', 'Yelan', 'Raiden Shogun', 'Shenhe', 'Kujou Sara', 'Dehya'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='S02'; Family='state'; GroupPath=@('角色状态型'); IndexLabel='02'; FolderName='02_长者权威_老成叙事'; Title='长者权威 老成叙事'; Description='更像长者、老成者、权威者的沉稳叙事线，接近你说的老头/老成感。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Zhongli', 'Neuvillette', 'Baizhu', 'Dainsleif', 'Kamisato Ayato', 'Diluc', 'Captain Wu'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='S03'; Family='state'; GroupPath=@('角色状态型'); IndexLabel='03'; FolderName='03_反派阴冷_操控轻蔑'; Title='反派阴冷 操控轻蔑'; Description='冷笑、轻蔑、操控感，适合反派、阴谋家、玩弄局面的角色。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('The Knave', 'Eide', 'Enjou', 'Childe', 'Tartaglia', 'Focalors', 'Fakhr', 'Shahzaman', 'Viramdra'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='S04'; Family='state'; GroupPath=@('角色状态型'); IndexLabel='04'; FolderName='04_油滑世故_圆滑商贩感'; Title='油滑世故 圆滑商贩感'; Description='更偏油滑、讨巧、世故、会来事的说话状态。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Young Merchant', 'Marcel', 'Edgar', 'Potton', 'Lauwick', 'Linlang', 'Qabus', 'Fakhr', 'Shahzaman', 'Kaeya', 'Yae Miko'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='S05'; Family='state'; GroupPath=@('角色状态型'); IndexLabel='05'; FolderName='05_死气沉沉_低能量疲态'; Title='死气沉沉 低能量疲态'; Description='气口塌、能量低、像没睡醒或被掏空，偏死气沉沉的状态。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Qiqi', 'Layla', 'Rosaria', 'Xiao', 'Baizhu', 'Yumemizuki Mizuki', 'Sigewinne', 'Lynette'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='S06'; Family='state'; GroupPath=@('角色状态型'); IndexLabel='06'; FolderName='06_病弱虚浮_轻气气短'; Title='病弱虚浮 轻气气短'; Description='虚弱、轻飘、气短，适合病弱、药师、体力不支一类的角色状态。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Baizhu', 'Qiqi', 'Collei', 'Layla', 'Sigewinne', 'Nahida'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='S07'; Family='state'; GroupPath=@('角色状态型'); IndexLabel='07'; FolderName='07_痞气挑衅_攻击拉满'; Title='痞气挑衅 攻击拉满'; Description='嘴角带刺、挑衅感强，适合痞帅、斗嘴、攻击性更高的角色状态。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Kaeya', 'Childe', 'Tartaglia', 'Wriothesley', 'Arataki Itto', 'Razor', 'Gaming', 'The Knave', 'Lyney'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='S08'; Family='state'; GroupPath=@('角色状态型'); IndexLabel='08'; FolderName='08_市井大叔_粗砺烟火'; Title='市井大叔 粗砺烟火'; Description='更接地气的大叔、市井、烟火味，粗粝感更重。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Captain Wu', 'Potton', 'Lauwick', 'Marcel', 'Edgar', 'Trinidad', 'Orban', 'Young Merchant', 'Dulphy'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' }
)

$performanceCategories = @(
    [pscustomobject]@{ Id='P01'; Family='performance'; GroupPath=@('表演质感型'); IndexLabel='01'; FolderName='01_戏精张力_舞台感强'; Title='戏精张力 舞台感强'; Description='抑扬顿挫大、表演味强，适合戏精、舞台感、强表演驱动的角色。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Furina', 'Hu Tao', 'Lyney', 'Yae Miko', 'Paimon', 'Faruzan'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='P02'; Family='performance'; GroupPath=@('表演质感型'); IndexLabel='02'; FolderName='02_梦呓空灵_疏离悬浮'; Title='梦呓空灵 疏离悬浮'; Description='空灵、梦感、疏离、像漂在半空的表演质地。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Nahida', 'Focalors', 'Yumemizuki Mizuki', 'Xianyun', 'Citlali', 'Chiori'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='' },
    [pscustomobject]@{ Id='P03'; Family='performance'; GroupPath=@('表演质感型'); IndexLabel='03'; FolderName='03_怒意爆发_高张力喊话'; Title='怒意爆发 高张力喊话'; Description='情绪上扬、爆发感明显，适合吵架、喊话、冲突升级场景。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Dehya', 'Mavuika', 'Beidou', 'Chasca', 'Arataki Itto', 'Chevreuse', 'Mualani', 'Paimon', 'The Knave'); RowTypes=$dialogTypes; TextPattern='[!！?？]'; TextExcludePattern='' },
    [pscustomobject]@{ Id='P04'; Family='performance'; GroupPath=@('表演质感型'); IndexLabel='04'; FolderName='04_冷面审讯_克制压声'; Title='冷面审讯 克制压声'; Description='压着说话、控制感强，像审问、盘问、判决、谈判桌压制。'; TargetCount=5; MaxPerSpeaker=2; Speakers=@('Neuvillette', 'Clorinde', 'Alhaitham', 'The Knave', 'Yelan', 'Kamisato Ayato'); RowTypes=$dialogTypes; TextPattern=''; TextExcludePattern='[!！]' }
)

$categories = @($baseCategories + $stateCategories + $performanceCategories)

if (Test-Path -LiteralPath $OutputRoot) {
    Remove-Item -LiteralPath $OutputRoot -Recurse -Force
}
$null = New-Item -ItemType Directory -Path $OutputRoot
$tempDownloadRoot = Join-Path $OutputRoot '_tmp'
$null = New-Item -ItemType Directory -Path $tempDownloadRoot

$categoryFolderMap = @{}
$categoryCounts = @{}
$categorySpeakerCounts = @{}
foreach ($category in $categories) {
    $folder = Ensure-DirectoryPath -Root $OutputRoot -Segments ($category.GroupPath + @($category.FolderName))
    $categoryFolderMap[$category.Id] = $folder
    $categoryCounts[$category.Id] = 0
    $categorySpeakerCounts[$category.Id] = @{}
}

$familySeenKeys = @{
    base = New-Object 'System.Collections.Generic.HashSet[string]'
    state = New-Object 'System.Collections.Generic.HashSet[string]'
    performance = New-Object 'System.Collections.Generic.HashSet[string]'
}

$manifestRows = New-Object System.Collections.Generic.List[object]
$pages = [math]::Ceiling($MaxRowsToScan / $PageSize)
$rowsScanned = 0

for ($page = 0; $page -lt $pages; $page++) {
    if (Test-AllCategoriesComplete -Categories $categories -CategoryCounts $categoryCounts) {
        break
    }

    $offset = $page * $PageSize
    $uri = [string]::Format($RowsEndpoint, $offset, $PageSize)
    Write-Host ("Scanning rows {0}-{1}" -f $offset, ($offset + $PageSize - 1))

    try {
        $response = Invoke-JsonRequest -Uri $uri -Retries 8 -DelaySeconds 3
    } catch {
        Write-Warning ("Skipping rows {0}-{1} after repeated request failures." -f $offset, ($offset + $PageSize - 1))
        continue
    }

    foreach ($entry in $response.rows) {
        $rowsScanned++
        $row = $entry.row

        if ($null -eq $row) { continue }
        if ($row.language -ne 'Chinese') { continue }
        if ([string]::IsNullOrWhiteSpace($row.speaker)) { continue }
        if ([string]::IsNullOrWhiteSpace($row.transcription)) { continue }
        if ($row.type -eq 'AnimatorEvent') { continue }

        $uniqueKey = if ([string]::IsNullOrWhiteSpace($row.inGameFilename)) {
            "row-$($entry.row_idx)"
        } else {
            $row.inGameFilename
        }

        $audioUrl = $null
        if ($row.audio -is [System.Array] -and $row.audio.Count -gt 0) {
            $audioUrl = $row.audio[0].src
        }
        if ([string]::IsNullOrWhiteSpace($audioUrl)) { continue }

        $selectedCategories = New-Object System.Collections.Generic.List[object]
        foreach ($family in @('base', 'state', 'performance')) {
            if ($familySeenKeys[$family].Contains($uniqueKey)) {
                continue
            }

            $familyCategories = @($categories | Where-Object { $_.Family -eq $family })
            $match = Get-NextMatchingCategory -Categories $familyCategories -Row $row -CategoryCounts $categoryCounts -CategorySpeakerCounts $categorySpeakerCounts
            if ($null -ne $match) {
                $selectedCategories.Add($match) | Out-Null
            }
        }

        if ($selectedCategories.Count -eq 0) { continue }

        $baseName = if ([string]::IsNullOrWhiteSpace($row.inGameFilename)) {
            "row_$($entry.row_idx)"
        } else {
            [System.IO.Path]::GetFileNameWithoutExtension($row.inGameFilename)
        }

        $tempName = "{0}_{1}_{2}.wav" -f (Get-SafeFileSegment -Value $row.speaker -MaxLength 24), (Get-SafeFileSegment -Value $baseName -MaxLength 48), ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $tempPath = Join-Path $tempDownloadRoot $tempName
        $downloaded = Invoke-FileDownload -Uri $audioUrl -Destination $tempPath -Retries 4 -DelaySeconds 2
        if (-not $downloaded) {
            continue
        }

        try {
            $durationInfo = Get-AudioDurationInfo -Path $tempPath -MinSeconds $MinDurationSeconds
        } catch {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
            continue
        }

        if (-not $durationInfo.MeetsMinimum) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
            continue
        }

        foreach ($category in $selectedCategories) {
            $speakerCountTable = $categorySpeakerCounts[$category.Id]
            if (-not $speakerCountTable.ContainsKey($row.speaker)) {
                $speakerCountTable[$row.speaker] = 0
            }
            if ($categoryCounts[$category.Id] -ge $category.TargetCount) {
                continue
            }
            if ($speakerCountTable[$row.speaker] -ge $category.MaxPerSpeaker) {
                continue
            }
            if ($familySeenKeys[$category.Family].Contains($uniqueKey)) {
                continue
            }

            $index = $categoryCounts[$category.Id] + 1
            $fileLabel = "{0:D2}_{1}_{2}" -f $index, (Get-SafeFileSegment -Value $row.speaker -MaxLength 32), (Get-SafeFileSegment -Value $baseName -MaxLength 72)
            $destination = Join-Path $categoryFolderMap[$category.Id] ($fileLabel + '.wav')
            Copy-Item -LiteralPath $tempPath -Destination $destination

            $categoryCounts[$category.Id]++
            $speakerCountTable[$row.speaker]++
            $null = $familySeenKeys[$category.Family].Add($uniqueKey)

            $manifestRows.Add([pscustomobject]@{
                category_id = $category.Id
                category_family = $category.Family
                category_group_path = ($category.GroupPath -join '/')
                category_title = $category.Title
                folder = $category.FolderName
                speaker = $row.speaker
                type = $row.type
                transcription = $row.transcription
                duration_seconds = [math]::Round($durationInfo.Seconds, 3)
                row_idx = $entry.row_idx
                in_game_filename = $row.inGameFilename
                source_audio_url = $audioUrl
                saved_path = $destination
            }) | Out-Null
        }

        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

Remove-Item -LiteralPath $tempDownloadRoot -Recurse -Force -ErrorAction SilentlyContinue

$manifestPath = Join-Path $OutputRoot 'manifest.json'
$summaryPath = Join-Path $OutputRoot 'summary.json'
$readmePath = Join-Path $OutputRoot 'README.md'

$manifestRows | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8

$summary = [pscustomobject]@{
    dataset_url = $DatasetUrl
    built_at = $RunTimestamp
    output_root = $OutputRoot
    minimum_duration_seconds = $MinDurationSeconds
    rows_scanned = $rowsScanned
    total_downloaded_files = $manifestRows.Count
    category_counts = ($categories | ForEach-Object {
        [pscustomobject]@{
            id = $_.Id
            family = $_.Family
            group_path = $_.GroupPath
            title = $_.Title
            folder = $_.FolderName
            description = $_.Description
            speakers = $_.Speakers
            target_count = $_.TargetCount
            count = $categoryCounts[$_.Id]
        }
    })
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding utf8

Write-VoicePresetReadme `
    -Destination $readmePath `
    -Categories $categories `
    -CategoryCounts $categoryCounts `
    -RowsScanned $rowsScanned `
    -DownloadedFiles $manifestRows.Count `
    -MinDurationSeconds $MinDurationSeconds

Write-Host ''
Write-Host 'Build complete.'
Write-Host ("Output root: {0}" -f $OutputRoot)
Write-Host ("Rows scanned: {0}" -f $rowsScanned)
Write-Host ("Files downloaded: {0}" -f $manifestRows.Count)
foreach ($category in $categories) {
    Write-Host ("[{0}] {1}: {2}/{3}" -f ($category.GroupPath -join '/'), $category.Title, $categoryCounts[$category.Id], $category.TargetCount)
}
