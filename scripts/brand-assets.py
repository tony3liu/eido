#!/usr/bin/env python3
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / 'native/branding'
BRAND.mkdir(parents=True, exist_ok=True)
# Two connected planes form an E: a task surface and three code lines.
POLYGONS = [
    [(256, 246), (448, 246), (448, 778), (256, 778)],
    [(496, 246), (770, 246), (770, 360), (496, 360)],
    [(496, 455), (706, 455), (706, 569), (496, 569)],
    [(496, 664), (770, 664), (770, 778), (496, 778)],
]
COLORS = ['#4b6df3', '#a2b4fa', '#7894f7', '#557af5']
shape = ''.join('<polygon points="' + ' '.join(f'{x},{y}' for x, y in polygon) + '"/>' for polygon in POLYGONS)
colored_shape = ''.join('<polygon fill="'+color+'" points="'+' '.join(f'{x},{y}' for x,y in polygon)+'"/>' for polygon,color in zip(POLYGONS,COLORS))
svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="48" y="48" width="928" height="928" rx="220" fill="#fcfdff" stroke="#e5edfc" stroke-width="2"/>'+colored_shape+'</svg>\n'
(BRAND / 'eido.svg').write_text(svg)
(BRAND / 'eido-mark.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g fill="currentColor">'+shape+'</g></svg>\n')
scale = 3
canvas = Image.new('RGBA', (1024*scale,1024*scale))
shadow = Image.new('RGBA',canvas.size)
ImageDraw.Draw(shadow).rounded_rectangle([48*scale,58*scale,976*scale,986*scale],radius=220*scale,fill=(95,139,183,54))
canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(13*scale)))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle([48*scale,48*scale,976*scale,976*scale],radius=220*scale,fill='#fcfdff')
for polygon,color in zip(POLYGONS,COLORS): draw.polygon([(x*scale,y*scale) for x,y in polygon],fill=color)
canvas = canvas.resize((1024,1024),Image.Resampling.LANCZOS)
canvas.save(BRAND / 'eido.png')
iconset = ROOT / '.local/branding/Eido.iconset'
iconset.mkdir(parents=True, exist_ok=True)
for size in [16,32,128,256,512]:
    for multiplier in [1,2]:
        suffix = '@2x' if multiplier==2 else ''
        canvas.resize((size*multiplier,size*multiplier),Image.Resampling.LANCZOS).save(iconset/f'icon_{size}x{size}{suffix}.png')
subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(BRAND/'Eido.icns')],check=True)
resources=ROOT/'native/overlay/crates/zed/resources'
resources.mkdir(parents=True,exist_ok=True)
for name in ['app-icon.png','app-icon-dev.png','app-icon-preview.png','app-icon-nightly.png']:
    canvas.save(resources/name)
images=ROOT/'native/overlay/assets/images'
images.mkdir(parents=True,exist_ok=True)
(images/'zed_logo.svg').write_text(svg)
(images/'eido-mark.svg').write_text((BRAND/'eido-mark.svg').read_text())
canvas.save(images/'eido-logo.png')
ui=ROOT/'native/overlay/crates/eido_ui/resources'
ui.mkdir(parents=True,exist_ok=True)
canvas.save(ui/'eido.png')
print('Generated Eido vector master, PNG, macOS ICNS and native overlay icons.')
