# Genera el banner "DISPONIBLE" (pill verde, PNG transparente) que el
# compositor /ig/img estampa sobre las historias. Regenerar y redeploy si cambia.
#
# Diseño: pill con gradiente verde, borde blanco y sombra suave para que sea
# legible sobre CUALQUIER fondo (blur oscuro, claro o blanco del modo pad).
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 700, 150
PAD = 18                      # margen para que la sombra no se recorte
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))

# ── Sombra suave ──
shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ds = ImageDraw.Draw(shadow)
ds.rounded_rectangle([PAD, PAD + 6, W - PAD, H - PAD + 6], radius=(H - 2 * PAD) // 2,
                     fill=(0, 0, 0, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(10))
img.alpha_composite(shadow)

# ── Pill con gradiente vertical (verde claro → verde oscuro) ──
pill = Image.new('RGBA', (W, H), (0, 0, 0, 0))
grad = Image.new('RGBA', (W, H), (0, 0, 0, 0))
dg = ImageDraw.Draw(grad)
TOP, BOT = (34, 197, 94), (21, 128, 61)
y0, y1 = PAD, H - PAD
for y in range(y0, y1):
    t = (y - y0) / max(1, y1 - y0)
    c = tuple(round(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)) + (255,)
    dg.line([(PAD, y), (W - PAD, y)], fill=c)
mask = Image.new('L', (W, H), 0)
dm = ImageDraw.Draw(mask)
dm.rounded_rectangle([PAD, PAD, W - PAD, H - PAD], radius=(H - 2 * PAD) // 2, fill=255)
pill.paste(grad, (0, 0), mask)
img.alpha_composite(pill)

# ── Borde blanco ──
d = ImageDraw.Draw(img)
d.rounded_rectangle([PAD, PAD, W - PAD, H - PAD], radius=(H - 2 * PAD) // 2,
                    outline=(255, 255, 255, 255), width=5)

# ── Punto "en vivo" (halo + centro) y texto con tracking ──
f = ImageFont.truetype(r'C:\Windows\Fonts\arialbd.ttf', 58)
cy = H // 2
d.ellipse([56, cy - 20, 96, cy + 20], fill=(255, 255, 255, 90))    # halo
d.ellipse([64, cy - 12, 88, cy + 12], fill='white')                # centro

TEXT, TRACK = "DISPONIBLE", 4
tw = sum(d.textlength(ch, font=f) + TRACK for ch in TEXT) - TRACK
x = 110 + ((W - PAD - 110) - tw) / 2       # centrado en el espacio a la derecha del punto
for ch in TEXT:
    d.text((x, cy + 2), ch, font=f, fill='white', anchor='lm')
    x += d.textlength(ch, font=f) + TRACK

out = r'worker\public\ig\disponible.png'
img.save(out)
print('OK', out, img.size)
