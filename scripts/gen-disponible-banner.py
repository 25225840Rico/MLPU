# Genera el banner "DISPONIBLE" (pill verde, PNG transparente) que el
# compositor /ig/img estampa sobre las historias. Regenerar y redeploy si cambia.
from PIL import Image, ImageDraw, ImageFont

W, H = 620, 130
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, W - 1, H - 1], radius=H // 2, fill=(22, 163, 74, 235))
f = ImageFont.truetype(r'C:\Windows\Fonts\arialbd.ttf', 62)
# puntito blanco "en vivo" + texto
d.ellipse([48, H / 2 - 14, 76, H / 2 + 14], fill='white')
d.text((W / 2 + 28, H / 2 - 2), "DISPONIBLE", font=f, fill='white', anchor='mm')

out = r'worker\public\ig\disponible.png'
img.save(out)
print('OK', out)
