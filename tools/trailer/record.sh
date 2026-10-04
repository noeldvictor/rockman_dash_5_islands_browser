#!/usr/bin/env bash
# Records the trailer's gameplay clips from the running dev server (cd web && npm run dev) into
# build/trailer/*.webm, by driving the game with tools/play.mjs: scripted keys, a simulated
# controller for the analog movement and camera sweeps, and settings switched between clips.
# Needs the save that "Continue" loads to be the shipped one (it travels to island 1, area 1-3).
set -euo pipefail
cd "$(dirname "$0")/../.."
out=build/trailer
mkdir -p "$out"
play() { node tools/play.mjs --gpu 1 --scale 4 --width 1800 --height 1163 --out "$out" "$@" 2>&1 | grep -v 'CreatePrimitive\|eval -> 1$' || true; }

# helpers in the page: S(key, value) changes a setting without saving it, ax(...) moves the
# simulated controller's sticks
SETUP="eval:(window.__pad={connected:true,id:'Trailer pad',buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]},navigator.getGamepads=()=>[window.__pad],window.ax=(lx,ly,rx,ry)=>{window.__pad.axes=[lx,ly,rx||0,ry||0]},window.S=(k,v)=>DOJA.settings.set(k,v,{persist:false}),1)"
ORIGINAL="eval:(S('wide',false),S('resolution',1),S('frameRate',15),S('legends2',false),S('textureFilter','sharp'),S('celShading',false),S('shadows',false),S('lighting',false),S('directStick',false),1)"
ENHANCED="eval:(S('wide',true),S('resolution',4),S('frameRate',60),S('textureFilter','ai'),S('celShading',true),S('shadows',true),S('directStick',true),DOJA.camera.recenter(),1)"

# ---- session 1: the Grassland (island 1, area 1-3) -------------------------------------------
steps=(wait:4500 key:Enter wait:3500 key:KeyQ wait:1500 key:Enter wait:1200 key:ArrowDown wait:400 key:Enter wait:1200
       key:Enter wait:3000 key:ArrowRight wait:500 key:ArrowRight wait:500 key:Enter wait:2500 key:Enter wait:7500 "$SETUP")
# a: the phone's picture, tank controls
steps+=("$ORIGINAL" wait:900 rec:start key:ArrowUp:2000 key:ArrowLeft:600 key:ArrowUp:1700 key:ArrowRight:800 key:ArrowUp:1300 wait:300 rec:stop:a_original)
# b: everything on, analog movement with the camera swinging round
steps+=("$ENHANCED" wait:3000 rec:start "eval:(ax(0,-1),1)" wait:1500 "eval:(ax(0.7,-0.7,0.35),1)" wait:1600 "eval:(ax(1,0,0.45),1)" wait:1400
        "eval:(ax(0.3,1,0.3),1)" wait:1500 "eval:(ax(-0.8,0.3,0),1)" wait:1300 "eval:(ax(0,0),1)" wait:400 rec:stop:b_enhanced)
# c: free camera around the player
steps+=(rec:start "eval:(ax(0,0,0.9,0.12),1)" wait:2600 "eval:(ax(0,0,0.9,-0.1),1)" wait:2600 "eval:(ax(0,0),1)" wait:300 rec:stop:c_camera)
# d: buster shots on the move
steps+=("eval:(DOJA.camera.recenter(),1)" wait:400 rec:start "eval:(ax(0,-0.8),1)" key:KeyZ:250 wait:250 key:KeyZ:250 wait:250 key:KeyZ:250 "eval:(ax(0.8,-0.3,0.3),1)" key:KeyZ:250 wait:250 key:KeyZ:250 wait:250 key:KeyZ:250 wait:250 key:KeyZ:250
        "eval:(ax(0,0),1)" wait:500 rec:stop:d_buster)
# e: the Legends 2 model, same spot
steps+=("eval:(S('legends2',true),DOJA.camera.recenter(),1)" wait:2500 rec:start "eval:(ax(0,0,0.9,0.1),1)" wait:2200 "eval:(ax(0,-1,0.3),1)" wait:1500 "eval:(ax(-0.8,-0.4,-0.3),1)" wait:1600
        "eval:(ax(0,0,-0.8),1)" wait:1500 "eval:(ax(0,0),1)" wait:300 rec:stop:e_legends2 "eval:JSON.stringify(DOJA.packStats)")
play --query "legends2=0" "${steps[@]}"

# ---- session 2: the New Game intro, with the Legends 2 models -------------------------------
steps=(wait:4500 key:ArrowUp wait:300 key:Enter wait:2500 "$SETUP" "$ENHANCED" "eval:(S('legends2',true),1)")
for _ in 1 2 3 4 5 6 7 8 9; do steps+=(key:Enter wait:900); done
steps+=(wait:1200 rec:start wait:1500)
for _ in 1 2 3 4 5; do steps+=(key:Enter wait:1700); done
steps+=(rec:stop:f_cutscene)
play "${steps[@]}"
ls -la "$out"/*.webm
