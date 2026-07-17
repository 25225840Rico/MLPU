# Genera la historia promocional 1080x1920 (/ig promo → worker/public/ig/promo.png).
# Diseño: fondo oscuro degradado + bandera a cuadros (racing, a tono con
# TopWheels), pill verde DISPONIBLE consistente con el banner de historias,
# couriers en pills con sus colores y CTA "Pídelo por DM".
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1080, 1920
ARIAL_B = r'C:\Windows\Fonts\arialbd.ttf'
ARIAL = r'C:\Windows\Fonts\arial.ttf'
EMOJI = r'C:\Windows\Fonts\seguiemj.ttf'

ROJO = (220, 38, 38)
VERDE_TOP, VERDE_BOT = (34, 197, 94), (21, 128, 61)
BLANCO = (255, 255, 255)
GRIS = (156, 163, 175)

def font(path, size):
    return ImageFont.truetype(path, size)

# ── Fondo: gradiente vertical oscuro ──
img = Image.new('RGB', (W, H), (11, 11, 16))
d = ImageDraw.Draw(img)
TOPC, BOTC = (13, 13, 19), (30, 30, 42)
for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)], fill=tuple(round(TOPC[i] + (BOTC[i] - TOPC[i]) * t) for i in range(3)))

# ── Bandera a cuadros (arriba y abajo, 2 filas de 55 px) ──
def checkered(y0, rows=2, size=55, alpha_even=235, alpha_odd=0):
    for r in range(rows):
        for c in range(0, W // size + 1):
            if (r + c) % 2 == 0:
                d.rectangle([c * size, y0 + r * size, (c + 1) * size - 1, y0 + (r + 1) * size - 1],
                            fill=(235, 235, 235))
checkered(0)   # solo arriba: abajo la UI de IG tapa esa zona y molestaba al texto

def center_text(y, text, f, fill, tracking=0):
    if tracking:
        tw = sum(d.textlength(ch, font=f) + tracking for ch in text) - tracking
        x = (W - tw) / 2
        for ch in text:
            d.text((x, y), ch, font=f, fill=fill, anchor='lm')
            x += d.textlength(ch, font=f) + tracking
    else:
        d.text((W / 2, y), text, font=f, fill=fill, anchor='mm')

def pill(x0, y0, x1, y1, top, bot, border=None):
    """Pill con gradiente vertical (paste con máscara redondeada)."""
    ph = y1 - y0
    grad = Image.new('RGB', (x1 - x0, ph))
    dg = ImageDraw.Draw(grad)
    for yy in range(ph):
        t = yy / ph
        dg.line([(0, yy), (x1 - x0, yy)],
                fill=tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    mask = Image.new('L', (x1 - x0, ph), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, x1 - x0 - 1, ph - 1], radius=ph // 2, fill=255)
    img.paste(grad, (x0, y0), mask)
    if border:
        d.rounded_rectangle([x0, y0, x1 - 1, y1 - 1], radius=ph // 2, outline=border, width=5)

# ── Marca ──
center_text(300, "TOPWHEELS.CL", font(ARIAL_B, 100), ROJO, tracking=6)
d.rectangle([W/2 - 170, 372, W/2 + 170, 378], fill=(60, 60, 74))

# ── Título ──
center_text(520, "STOCK", font(ARIAL_B, 210), BLANCO, tracking=10)

# Pill DISPONIBLE (mismo lenguaje visual que el banner de historias)
py0, py1 = 650, 810
pill(150, py0, W - 150, py1, VERDE_TOP, VERDE_BOT, border=BLANCO)
cy = (py0 + py1) // 2
d.ellipse([205, cy - 22, 249, cy + 22], fill=(255, 255, 255, 90))
d.ellipse([213, cy - 14, 241, cy + 14], fill=BLANCO)
f_disp = font(ARIAL_B, 74)
tw = sum(d.textlength(ch, font=f_disp) + 4 for ch in "DISPONIBLE") - 4
x = 265 + ((W - 150 - 265) - tw) / 2
for ch in "DISPONIBLE":
    d.text((x, cy + 2), ch, font=f_disp, fill=BLANCO, anchor='lm')
    x += d.textlength(ch, font=f_disp) + 4

# ── Envíos ──
center_text(940, "ENVÍOS A TODO CHILE", font(ARIAL_B, 76), BLANCO)
d.text((W / 2, 1040), "🚚 📦", font=font(EMOJI, 64), anchor='mm', embedded_color=True)

# ── Couriers ──
bands = [
    ("STARKEN",      (22, 163, 74), (17, 110, 52),  BLANCO),
    ("CHILEXPRESS",  (252, 211, 77), (234, 179, 8), (17, 17, 17)),
    ("BLUE EXPRESS", (59, 130, 246), (29, 78, 216), BLANCO),
]
y = 1130
for name, top, bot, fg in bands:
    pill(140, y, W - 140, y + 130, top, bot)
    d.text((W / 2, y + 65), name, font=font(ARIAL_B, 66), fill=fg, anchor='mm')
    y += 165

# ── CTA (emoji con fuente de emojis; Arial lo dibuja como tofu) ──
pill(240, 1620, W - 240, 1730, ROJO, (165, 28, 28), border=BLANCO)
f_cta, f_emoji = font(ARIAL_B, 54), font(EMOJI, 50)
cta = "PÍDELO POR DM"
GAP = 18
emoji_w = d.textlength("XX", font=f_emoji) + GAP
total = emoji_w + d.textlength(cta, font=f_cta)
x0 = (W - total) / 2
d.text((x0, 1675), "📩", font=f_emoji, anchor='lm', embedded_color=True)
d.text((x0 + emoji_w, 1675), cta, font=f_cta, fill=BLANCO, anchor='lm')

# ── Entrega presencial (2 líneas para que no se desborde) ──
center_text(1795, "ENTREGAS PRESENCIALES", font(ARIAL_B, 44), BLANCO)
center_text(1855, "Oficina La Poderosa 175 · Antofagasta", font(ARIAL_B, 42), (34, 197, 94))

out = r'worker\public\ig\promo.png'
img.save(out, optimize=True)
print('OK', out, img.size)
