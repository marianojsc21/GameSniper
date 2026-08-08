# Genera los íconos PNG de la extensión usando System.Drawing
Add-Type -AssemblyName System.Drawing

$sizes = @(16, 32, 48, 128)
$outDir = Join-Path $PSScriptRoot "icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  # fondo: gradiente oscuro
  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $c1 = [System.Drawing.Color]::FromArgb(255, 11, 14, 23)
  $c2 = [System.Drawing.Color]::FromArgb(255, 22, 33, 59)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45)
  $g.FillRectangle($grad, $rect)

  # texto "OF" en verde
  $fs = [Math]::Max(7, [Math]::Floor($s * 0.5))
  $font = New-Object System.Drawing.Font("Segoe UI", $fs, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 56, 224, 139))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $txtRect = New-Object System.Drawing.RectangleF(0, -[Math]::Floor($s*0.02), $s, $s)
  $g.DrawString("OF", $font, $brush, $txtRect, $fmt)

  $path = Join-Path $outDir ("icon{0}.png" -f $s)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $grad.Dispose(); $font.Dispose(); $brush.Dispose(); $fmt.Dispose()
  Write-Output ("generated " + $path)
}
