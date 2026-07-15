# Genera la historia promocional 1080x1920 (test de diseño)
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
img = Image.new('RGB', (W, H), 'white')
d = ImageDraw.Draw(img)

def font(path, size):
    return ImageFont.truetype(path, size)

ARIAL_B = r'C:\Windows\Fonts\arialbd.ttf'
ARIAL = r'C:\Windows\Fonts\arial.ttf'

def center_text(y, text, f, fill):
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)
    return f.size

# ── Marca arriba en rojo ──
d.text((W/2, 180), "TOPWHEELS.CL", font=font(ARIAL_B, 92), fill=(220, 38, 38), anchor='mm')

# ── Título gigante ──
d.text((W/2, 430), "STOCK", font=font(ARIAL_B, 185), fill=(17, 17, 17), anchor='mm')
d.text((W/2, 600), "DISPONIBLE", font=font(ARIAL_B, 145), fill=(22, 163, 74), anchor='mm')

# línea separadora
d.rectangle([W/2-220, 705, W/2+220, 713], fill=(17,17,17))

d.text((W/2, 800), "ENVÍOS A TODO CHILE", font=font(ARIAL_B, 78), fill=(17, 17, 17), anchor='mm')
d.text((W/2, 890), "🚚📦", font=font(r'C:\Windows\Fonts\seguiemj.ttf', 66), fill=None, anchor='mm', embedded_color=True)

# ── Bandas de couriers (pill) ──
bands = [
    ("STARKEN",       (22, 163, 74),  'white'),   # verde
    ("CHILEXPRESS",   (250, 204, 21), (17,17,17)),# amarillo
    ("BLUE EXPRESS",  (37, 99, 235),  'white'),   # azul
]
y = 990
for name, bg, fg in bands:
    d.rounded_rectangle([100, y, W-100, y+160], radius=80, fill=bg)
    d.text((W/2, y+80), name, font=font(ARIAL_B, 84), fill=fg, anchor='mm')
    y += 215

# ── Entrega en oficina ── (y ≈ 1635 acá)
d.text((W/2, 1700), "ENTREGAS EN OFICINA", font=font(ARIAL_B, 56), fill=(17,17,17), anchor='mm')
d.text((W/2, 1790), "La Poderosa 175 · Antofagasta", font=font(ARIAL_B, 60), fill=(22, 163, 74), anchor='mm')

out = r'C:\Users\aronr\AppData\Local\Temp\claude\C--WINDOWS-system32\9cb5b8dc-97fe-4b7f-a026-5e9bd055191f\scratchpad\promo-story.png'
img.save(out, optimize=True)
print('OK', out)
