# 从源图生成应用图标：正方形居中裁剪 → 多尺寸 PNG → 合成 ICO
# 用法：pwsh -File scripts/make-icon.ps1 -Source "C:\path\to\image.jpg"
param(
  [Parameter(Mandatory = $true)][string]$Source
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
$iconsDir = Join-Path $buildDir 'icons'
New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

# 1. 保留一份原图，便于日后用不同尺寸重新生成
$sourceCopy = Join-Path $buildDir 'icon-source.jpg'
Copy-Item $Source $sourceCopy -Force
Write-Host "源图已保存: $sourceCopy"

# 2. 居中裁剪为正方形（头像类构图：以偏上部分为主体，故纵向略微上移取景）
$img = [System.Drawing.Image]::FromFile($sourceCopy)
try {
  $side = [Math]::Min($img.Width, $img.Height)
  $x = [int](($img.Width - $side) / 2)
  # 纵向：人物主体多在中上部，取景中心上移 6%，避免把脸裁掉
  $yRaw = [int](($img.Height - $side) / 2) - [int]($side * 0.06)
  $y = [Math]::Max(0, [Math]::Min($yRaw, $img.Height - $side))

  $square = New-Object System.Drawing.Bitmap($side, $side)
  $g = [System.Drawing.Graphics]::FromImage($square)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $side, $side)), (New-Object System.Drawing.Rectangle($x, $y, $side, $side)), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
} finally {
  $img.Dispose()
}

# 3. 输出各尺寸 PNG
$sizes = @(16, 24, 32, 48, 64, 128, 256, 512)
foreach ($s in $sizes) {
  $out = New-Object System.Drawing.Bitmap($s, $s)
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.DrawImage($square, 0, 0, $s, $s)
  $g2.Dispose()
  $path = Join-Path $iconsDir "icon-$s.png"
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Host "  $path"
}

# 4. 512 作为通用 icon.png（Electron 窗口图标 / Linux）
Copy-Item (Join-Path $iconsDir 'icon-512.png') (Join-Path $buildDir 'icon.png') -Force

$square.Dispose()
Write-Host "完成。接下来运行 node scripts/make-ico.js 合成 icon.ico"
