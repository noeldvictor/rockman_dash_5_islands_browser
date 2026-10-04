#!/usr/bin/env bash
# Cuts the clips recorded by record.sh, some stills from docs/ and the game's title music (as the
# port's own synthesiser plays it) into build/trailer/trailer.mp4: 1080p, 60 fps.
set -euo pipefail
cd "$(dirname "$0")/../.."
T=build/trailer
W=$T/work
mkdir -p "$W"
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
ENC=(-c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -r 60 -an)
n=0

CAPTION_Y="h-140"  # set to 70 for clips whose bottom is taken by the game's own dialogue box
caption() {  # drawtext filter for a caption; the text goes through a file to avoid escaping
  printf '%s' "$1" > "$W/cap_$n.txt"
  echo "drawtext=fontfile=$FONT:textfile=$W/cap_$n.txt:fontsize=46:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=20:x=(w-text_w)/2:y=$CAPTION_Y"
}
fades() { echo "fade=t=in:st=0:d=0.3,fade=t=out:st=$(python3 -c "print($1-0.3)"):d=0.3"; }

clip() {  # clip <file> <start> <duration> <caption> [extra video filter before the caption]
  n=$((n + 1))
  local pre=${5:-"scale=1920:1080:flags=lanczos"}
  ffmpeg -v error -y -ss "$2" -t "$3" -i "$T/$1.webm" -vf "fps=60,$pre,$(caption "$4"),$(fades "$3")" "${ENC[@]}" "$W/seg_$(printf %02d $n).mp4"
}
still() {  # still <image> <duration> <caption>: a slow push-in on a picture, letterboxed on black
  n=$((n + 1))
  ffmpeg -v error -y -loop 1 -framerate 60 -t "$2" -i "$1" -vf "scale=3840:2160:force_original_aspect_ratio=decrease:flags=lanczos,pad=3840:2160:(ow-iw)/2:(oh-ih)/2:black,zoompan=z='1+0.05*on/($2*60)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=60,$(caption "$3"),$(fades "$2")" "${ENC[@]}" "$W/seg_$(printf %02d $n).mp4"
}
card() {  # card <background image> <duration> <line 1> <line 2> <line 3>
  n=$((n + 1))
  printf '%s' "$3" > "$W/c1_$n.txt"; printf '%s' "$4" > "$W/c2_$n.txt"; printf '%s' "$5" > "$W/c3_$n.txt"
  ffmpeg -v error -y -loop 1 -framerate 60 -t "$2" -i "$1" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=24:2,eq=brightness=-0.28,fps=60,\
drawtext=fontfile=$FONT:textfile=$W/c1_$n.txt:fontsize=56:fontcolor=white:x=(w-text_w)/2:y=400,\
drawtext=fontfile=$FONT:textfile=$W/c2_$n.txt:fontsize=44:fontcolor=0xe6c15a:x=(w-text_w)/2:y=510,\
drawtext=fontfile=$FONT:textfile=$W/c3_$n.txt:fontsize=34:fontcolor=0xd7dce5:x=(w-text_w)/2:y=600,$(fades "$2")" "${ENC[@]}" "$W/seg_$(printf %02d $n).mp4"
}

rm -f "$W"/seg_*.mp4
card docs/title.jpg 4.5 "Rockman DASH: Great Adventure on 5 Islands" "the 2008 phone game, running in a web browser" "unofficial fan port"
clip a_original 0.2 6.4 "2008: a 240 x 240 phone screen, 15 frames a second" "scale=1080:1080:flags=neighbor,pad=1920:1080:420:0:black"
clip b_enhanced 0.4 7.0 "Now: widescreen, high resolution, 60 fps"
clip c_camera 0.2 5.0 "Free camera: right stick, mouse or touch"
clip d_buster 0.2 3.7 "Direct movement, controller support, rebindable controls"
still docs/textures-ai-characters.jpg 5 "Optional AI-upscaled textures (left: original, right: upscaled)"
CAPTION_Y=70
clip f_cutscene 0.5 4.6 "Optional Mega Man Legends 2 character models"
clip f_cutscene 5.1 4.6 "Cel shading, lighting and shadows"
CAPTION_Y="h-140"
still docs/settings.jpg 4.5 "One settings menu. Everything is optional."
card docs/gameplay.jpg 6.5 "No emulator: the game's code is recompiled to JavaScript" "github.com/noeldvictor/rockman_dash_5_islands_browser" "Bring your own game files. Fully vibe coded: fork it and do what you want."

ls "$W"/seg_*.mp4 | sed "s#.*/#file '#;s#\$#'#" > "$W/list.txt"
ffmpeg -v error -y -f concat -safe 0 -i "$W/list.txt" -c copy "$W/video.mp4"
length=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$W/video.mp4")

# music: the title theme, as the port plays it (sampled instruments if they have been generated)
font=(); [ -f web/public/soundfont/gm.json ] && font=(--soundfont web/public/soundfont)
node tools/mfi/render.mjs build/assets/localized/sp/sound/bgmtitle.mld "$W/music.wav" --passes 4 "${font[@]}" > /dev/null
ffmpeg -v error -y -i "$W/video.mp4" -i "$W/music.wav" -filter_complex "[1:a]atrim=0:$length,afade=t=in:st=0:d=0.5,afade=t=out:st=$(python3 -c "print($length-2.5)"):d=2.5,volume=1.6[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -movflags +faststart "$T/trailer.mp4"
echo "trailer: $T/trailer.mp4, $(printf %.1f "$length") s, $(du -h "$T/trailer.mp4" | cut -f1)"
