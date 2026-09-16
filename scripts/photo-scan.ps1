# P4 photo mark scanner: locate marked printed words on a photo of a workbook page.
#
# Pipeline (deterministic CV in inline C# for speed; PowerShell only drives it):
#   1. mask = saturated ink pixels; classify each as highlighter (non-red hue) or red pen
#      (unsaturated dark pixels are recorded separately as "printed ink")
#   2. connected components + shape features
#   3. keep only marks that plausibly flag a printed word:
#        highlighter : w >= 24, 6 <= h <= 60          (a band over words, not an illustration)
#        red-line    : w >= 30, h <= 14, w/h >= 3     (underline / strikethrough, ABSOLUTE size --
#                                                      a relative test also matched Chinese strokes)
#        red-circle  : w >= 20, h >= 15, fill <= 0.30, printed ink inside >= 60
#        red-check   : maxDim <= 26, fill <= 0.45, printed ink inside >= 60
#      everything else (red handwriting, annotations, specks, page-edge smears) is dropped
#   4. merge marks sharing a text line (same centre Y + small horizontal gap; centre-based so
#      boxes cannot chain across lines), pad (up 30px: an underline must bring its word in)
#   5. drop crops without enough horizontally-spread printed ink (empty margins, illustrations)
#   6. write one crop per region + a single contact sheet PNG so a model can judge every
#      candidate region in ONE image
#
# ASCII-ONLY ON PURPOSE (PS 5.1 reads a BOM-less .ps1 as ANSI/GBK; any non-ASCII byte -- in
# comments OR data -- corrupts parsing). All paths travel in as parameters.
param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$SatMin = 40,
    [int]$ValMin = 70,
    [int]$MinPx = 20,
    [int]$PadSide = 8,
    [int]$PadUp = 30,
    [int]$PadDown = 8,
    [int]$MergeGapX = 16,
    [int]$MergeCenterY = 12,
    [int]$MaxMergedH = 72,
    [int]$MaxBoxW = 900,
    [int]$MinCropDark = 90,
    [double]$MinDarkSpread = 0.45,
    [int]$MaxCropH = 160,
    [int]$SheetWidth = 1000,
    [int]$MaxSheetH = 5200,
    [switch]$DebugDropped,
    [string]$Stem = 'photo'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$cs = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class WvPhotoScan
{
    public class Box
    {
        public int x0, y0, x1, y1, ink, cy;
        public List<string> reasons = new List<string>();
        public int W { get { return x1 - x0 + 1; } }
        public int H { get { return y1 - y0 + 1; } }
    }

    static int w, h, stride;
    static byte[] pix;      // raw BGRA
    static byte[] mask;     // 0 none, 1 highlighter, 2 red
    static byte[] dark;     // 1 = unsaturated dark (printed text / pencil)

    public static string Run(string path, string outDir, string stem,
        int satMin, int valMin, int minPx, int padSide, int padUp, int padDown,
        int mergeGapX, int mergeCenterY, int maxMergedH, int maxBoxW, int minCropDark, double minDarkSpread,
        int maxCropH, int sheetWidth, int maxSheetH, bool debugDropped)
    {
        Bitmap src = new Bitmap(path);
        w = src.Width; h = src.Height;
        BitmapData bd = src.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        stride = bd.Stride;
        pix = new byte[stride * h];
        Marshal.Copy(bd.Scan0, pix, 0, pix.Length);
        src.UnlockBits(bd);

        mask = new byte[w * h]; dark = new byte[w * h];
        for (int y = 0; y < h; y++)
        {
            int row = y * stride;
            for (int x = 0; x < w; x++)
            {
                int i = row + x * 4;
                byte b = pix[i], g = pix[i + 1], r = pix[i + 2];
                int mx = Math.Max(r, Math.Max(g, b)), mn = Math.Min(r, Math.Min(g, b));
                int sat = mx - mn;
                if (sat < satMin || mx < valMin)
                {
                    if (mx < 150) dark[y * w + x] = 1;
                    continue;
                }
                double hue;
                if (mx == r) hue = 60.0 * (((g - b) / (double)sat) % 6);
                else if (mx == g) hue = 60.0 * (((b - r) / (double)sat) + 2);
                else hue = 60.0 * (((r - g) / (double)sat) + 4);
                if (hue < 0) hue += 360;
                mask[y * w + x] = (byte)((hue < 16.0 || hue >= 340.0) ? 2 : 1);
            }
        }

        // connected components
        int[] label = new int[w * h];
        int[] stack = new int[w * h];
        List<Box> kept = new List<Box>();
        StringBuilder dropped = new StringBuilder();
        int next = 1;
        for (int y0 = 0; y0 < h; y0++)
        {
            for (int x0 = 0; x0 < w; x0++)
            {
                int p0 = y0 * w + x0;
                if (mask[p0] == 0 || label[p0] != 0) continue;
                int sp = 0; stack[sp++] = p0; label[p0] = next;
                int cx0 = x0, cx1 = x0, cy0 = y0, cy1 = y0, px = 0;
                long sr = 0, sg = 0, sb = 0;
                while (sp > 0)
                {
                    int p = stack[--sp];
                    int y = p / w, x = p - y * w;
                    px++; int ii = y * stride + x * 4;
                    sr += pix[ii + 2]; sg += pix[ii + 1]; sb += pix[ii];
                    if (x < cx0) cx0 = x; if (x > cx1) cx1 = x;
                    if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
                    int[] dx = { 1, -1, 0, 0 }; int[] dy = { 0, 0, 1, -1 };
                    for (int k = 0; k < 4; k++)
                    {
                        int nx = x + dx[k], ny = y + dy[k];
                        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        int np = ny * w + nx;
                        if (mask[np] == 0 || label[np] != 0) continue;
                        label[np] = next; stack[sp++] = np;
                    }
                }
                int myLabel = next; next++;
                int bw = cx1 - cx0 + 1, bh = cy1 - cy0 + 1;
                if (px < minPx || bw > maxBoxW) continue;
                double rr = sr / (double)px, gg = sg / (double)px, bb = sb / (double)px;
                int mx2 = (int)Math.Max(rr, Math.Max(gg, bb)), mn2 = (int)Math.Min(rr, Math.Min(gg, bb));
                int sat2 = mx2 - mn2;
                double hue2;
                if (mx2 == (int)rr) hue2 = 60.0 * (((gg - bb) / sat2) % 6);
                else if (mx2 == (int)gg) hue2 = 60.0 * (((bb - rr) / sat2) + 2);
                else hue2 = 60.0 * (((rr - gg) / sat2) + 4);
                if (hue2 < 0) hue2 += 360;
                bool red = (hue2 < 16.0 || hue2 >= 340.0);
                double fill = px / (double)(bw * bh);
                int darkInside = 0;
                for (int y = cy0; y <= cy1; y++)
                    for (int x = cx0; x <= cx1; x++)
                        if (dark[y * w + x] == 1) darkInside++;

                string reason = null;
                if (!red)
                {
                    if (bw >= 24 && bh >= 6 && bh <= 60) reason = "highlighter";
                }
                else
                {
                    if (bw >= 30 && bh <= 14 && bw / (double)bh >= 3.0) reason = "red-line";
                    else if (bw >= 20 && bh >= 15 && fill <= 0.30 && darkInside >= 60) reason = "red-circle";
                    else if (Math.Max(bw, bh) <= 26 && fill <= 0.45 && darkInside >= 60) reason = "red-check";
                }
                if (reason == null)
                {
                    if (debugDropped && dropped.Length < 4000)
                        dropped.Append("{\"x0\":").Append(cx0).Append(",\"y0\":").Append(cy0)
                            .Append(",\"w\":").Append(bw).Append(",\"h\":").Append(bh)
                            .Append(",\"fill\":").Append(Math.Round(fill, 2))
                            .Append(",\"dark\":").Append(darkInside)
                            .Append(",\"kind\":\"").Append(red ? "red" : "hl").Append("\"},");
                    continue;
                }
                Box bx = new Box();
                bx.x0 = cx0; bx.y0 = cy0; bx.x1 = cx1; bx.y1 = cy1; bx.ink = px;
                bx.cy = (cy0 + cy1) / 2; bx.reasons.Add(reason);
                kept.Add(bx);
            }
        }

        // merge marks on the same text line (centre-based: no chaining across lines)
        kept.Sort(delegate (Box a, Box b) { return a.y0 != b.y0 ? a.y0 - b.y0 : a.x0 - b.x0; });
        List<Box> merged = new List<Box>();
        foreach (Box c in kept)
        {
            bool done = false;
            foreach (Box b in merged)
            {
                // merge marks that share a text line (vertical overlap), but never let a merged
                // box grow past maxMergedH -- otherwise boxes chain downwards across lines
                bool vOverlap = !(c.y0 > b.y1 + 4 || c.y1 < b.y0 - 4);
                if (!vOverlap) continue;
                int nh = Math.Max(b.y1, c.y1) - Math.Min(b.y0, c.y0) + 1;
                if (nh > maxMergedH) continue;
                bool hClose = !(c.x0 > b.x1 + mergeGapX || c.x1 < b.x0 - mergeGapX);
                if (!hClose) continue;
                if (c.x0 < b.x0) b.x0 = c.x0;
                if (c.x1 > b.x1) b.x1 = c.x1;
                if (c.y0 < b.y0) b.y0 = c.y0;
                if (c.y1 > b.y1) b.y1 = c.y1;
                b.ink += c.ink;
                foreach (string r in c.reasons) if (!b.reasons.Contains(r)) b.reasons.Add(r);
                done = true; break;
            }
            if (!done)
            {
                Box nb = new Box();
                nb.x0 = c.x0; nb.y0 = c.y0; nb.x1 = c.x1; nb.y1 = c.y1; nb.ink = c.ink; nb.cy = c.cy;
                nb.reasons.AddRange(c.reasons);
                merged.Add(nb);
            }
        }

        // crop, measure printed-ink spread, keep the useful ones
        StringBuilder json = new StringBuilder();
        json.Append("{\"image\":\"").Append(path.Replace("\\", "\\\\")).Append("\",\"width\":").Append(w)
            .Append(",\"height\":").Append(h).Append(",\"regions\":[");
        StringBuilder sheetJson = new StringBuilder("[");
        List<Bitmap> crops = new List<Bitmap>();
        List<string> labels = new List<string>();
        int idx = 0, skipped = 0;
        foreach (Box b in merged)
        {
            int cx0 = Math.Max(0, b.x0 - padSide), cy0 = Math.Max(0, b.y0 - padUp);
            int cx1 = Math.Min(w - 1, b.x1 + padSide), cy1 = Math.Min(h - 1, b.y1 + padDown);
            int cw = cx1 - cx0 + 1, chh = cy1 - cy0 + 1;
            if (chh > maxCropH) { cy0 = Math.Max(0, cy1 - maxCropH + 1); chh = cy1 - cy0 + 1; }
            Bitmap crop = new Bitmap(cw, chh);
            using (Graphics g = Graphics.FromImage(crop))
                g.DrawImage(src, new Rectangle(0, 0, cw, chh), new Rectangle(cx0, cy0, cw, chh), GraphicsUnit.Pixel);
            int darkPx = 0, colsWithDark = 0;
            for (int x = 0; x < cw; x++)
            {
                bool colHas = false;
                for (int y = 0; y < chh; y++)
                {
                    Color p = crop.GetPixel(x, y);
                    int mx = Math.Max(p.R, Math.Max(p.G, p.B)), mn = Math.Min(p.R, Math.Min(p.G, p.B));
                    if ((mx - mn) < satMin && mx < 150) { darkPx++; colHas = true; }
                }
                if (colHas) colsWithDark++;
            }
            double spread = colsWithDark / (double)cw;
            if (darkPx < minCropDark || spread < minDarkSpread)
            {
                skipped++;
                crop.Dispose();
                continue;
            }
            idx++;
            string rel = stem + "_r" + idx.ToString("00") + "_y" + cy0 + "-" + cy1 + ".png";
            crop.Save(System.IO.Path.Combine(outDir, rel), ImageFormat.Png);
            crops.Add(crop);
            labels.Add("r" + idx + "  y" + cy0 + "-" + cy1 + "  " + string.Join("+", b.reasons.ToArray()) + "  dark" + darkPx);
            if (idx > 1) json.Append(",");
            json.Append("{\"index\":").Append(idx).Append(",\"file\":\"").Append(rel.Replace("\\", "\\\\"))
                .Append("\",\"x0\":").Append(cx0).Append(",\"y0\":").Append(cy0)
                .Append(",\"x1\":").Append(cx1).Append(",\"y1\":").Append(cy1)
                .Append(",\"w\":").Append(cw).Append(",\"h\":").Append(chh)
                .Append(",\"ink\":").Append(b.ink).Append(",\"dark\":").Append(darkPx)
                .Append(",\"spread\":").Append(Math.Round(spread, 2))
                .Append(",\"reasons\":\"").Append(string.Join("+", b.reasons.ToArray())).Append("\"}");
        }
        json.Append("],\"skipped\":").Append(skipped).Append(",\"dropped\":[").Append(dropped.ToString().TrimEnd(',')).Append("],\"sheets\":[");
        for (int i = 0; i < sheetJson.Length; i++) { }
        json.Append(sheetJson.ToString().TrimStart('['));
        json.Append("]}");

        // contact sheet(s): one image a model can read to judge every candidate region at once
        List<string> sheetFiles = new List<string>();
        int si = 0;
        int cur = 0;
        while (cur < crops.Count)
        {
            si++;
            int used = 0, totalH = 0;
            List<int> pick = new List<int>();
            while (cur + used < crops.Count)
            {
                int k = cur + used;
                Bitmap c = crops[k];
                double scale = Math.Min(1.0, (sheetWidth - 20) / (double)c.Width);
                int scaledH = (int)Math.Round(c.Height * scale);
                if (used > 0 && totalH + scaledH + 34 > maxSheetH) break;
                pick.Add(k); totalH += scaledH + 34; used++;
            }
            if (pick.Count == 0) break;
            Bitmap sheet = new Bitmap(sheetWidth, Math.Min(maxSheetH, totalH + 10));
            using (Graphics g = Graphics.FromImage(sheet))
            {
                g.Clear(Color.White);
                Font f = new Font("Consolas", 14);
                SolidBrush br = new SolidBrush(Color.FromArgb(200, 0, 90));
                int y = 4;
                foreach (int k in pick)
                {
                    Bitmap c = crops[k];
                    double scale = Math.Min(1.0, (sheetWidth - 20) / (double)c.Width);
                    int sw = (int)Math.Round(c.Width * scale), sh = (int)Math.Round(c.Height * scale);
                    g.DrawString(labels[k], f, br, 6, y);
                    y += 28;
                    g.DrawImage(c, new Rectangle(6, y, sw, sh));
                    y += sh + 6;
                    g.DrawLine(Pens.LightGray, 0, y - 3, sheetWidth, y - 3);
                }
                f.Dispose(); br.Dispose();
            }
            string sf = stem + "_sheet" + si + ".png";
            sheet.Save(System.IO.Path.Combine(outDir, sf), ImageFormat.Png);
            sheetFiles.Add(sf);
            sheet.Dispose();
            cur += pick.Count;
        }
        foreach (Bitmap c in crops) c.Dispose();
        src.Dispose();

        string result = json.ToString();
        int at = result.LastIndexOf("\"sheets\":[");
        StringBuilder finalStr = new StringBuilder(result.Substring(0, at));
        finalStr.Append("\"sheets\":[");
        for (int i = 0; i < sheetFiles.Count; i++)
        {
            if (i > 0) finalStr.Append(",");
            finalStr.Append("\"").Append(sheetFiles[i]).Append("\"");
        }
        finalStr.Append("]}");
        return finalStr.ToString();
    }
}
'@
Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$json = [WvPhotoScan]::Run($ImagePath, $OutDir, $Stem, $SatMin, $ValMin, $MinPx, $PadSide, $PadUp, $PadDown,
    $MergeGapX, $MergeCenterY, $MaxMergedH, $MaxBoxW, $MinCropDark, $MinDarkSpread, $MaxCropH, $SheetWidth, $MaxSheetH, [bool]$DebugDropped)
$outJson = Join-Path $OutDir ($Stem + "_marks.json")
[System.IO.File]::WriteAllText($outJson, $json, (New-Object System.Text.UTF8Encoding($false)))
$data = $json | ConvertFrom-Json
Write-Output ("image " + $data.width + "x" + $data.height + "  regions=" + $data.regions.Count + "  skipped(no printed text)=" + $data.skipped + "  dropped(handwriting/specks)=" + $data.dropped.Count)
$data.regions | ForEach-Object { Write-Output ("  r{0} y={1}-{2} x={3}-{4} {5}x{6} dark={7} spread={8} why={9}" -f $_.index, $_.y0, $_.y1, $_.x0, $_.x1, $_.w, $_.h, $_.dark, $_.spread, $_.reasons) }
if ($DebugDropped) {
    Write-Output "dropped sample:"
    $data.dropped | Select-Object -First 10 | ForEach-Object { Write-Output ("  drop x={0} y={1} {2}x{3} fill={4} dark={5} {6}" -f $_.x0, $_.y0, $_.w, $_.h, $_.fill, $_.dark, $_.kind) }
}
Write-Output ("sheets: " + (($data.sheets) -join ', '))
Write-Output ("json: " + $outJson)
