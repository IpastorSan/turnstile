#!/usr/bin/env python3
"""Fit the silent picture to the voiceover and export the submission mp4.

Each take is one audio file; each take has a list of clips. The picture for a take
is its clips concatenated, then fitted to the audio: if the picture is longer, the
clip with the most spare time is trimmed from its end; if shorter, the last frame is
held. Nothing is ever sped up (ETHGlobal disqualifies speed-ups).
"""
import json, subprocess, sys, pathlib, shutil

V = pathlib.Path(sys.argv[1])
VO = pathlib.Path(sys.argv[2])
OUT = pathlib.Path(sys.argv[3])
W = V / 'build'; W.mkdir(exist_ok=True)
marks = json.loads((V / 'browser' / 'marks.json').read_text())

TAKES = [
    ('0a', [('slide', 'slide1-title')]),
    ('0b', [('slide', 'slide2-problem')]),
    ('0c', [('slide', 'slide3-how')]),
    ('1',  [('clip', 's1-market')]),
    ('2',  [('clip', 's2-seller')]),
    ('3',  [('clip', 's3a-402'), ('clip', 's3b-hederapay'), ('clip', 's3c-hashscan')]),
    ('4',  [('clip', 's4a-mandate'), ('clip', 's4b-arcscan'), ('clip', 's4c-nonce')]),
    ('5',  [('clip', 's5-forge')]),
    ('6',  [('clip', 's6-evidence')]),
]
PAD = 0.5  # breathing room after each take
# Seconds of each clip that must survive trimming, because the thing the line talks
# about appears that late: the 402 output after the command is typed, the refusal after
# the probe click, the payment run's final lines (never trimmed).
MIN_KEEP = {'s3a-402': 8.5, 's3b-hederapay': 999.0, 's3c-hashscan': 7.0,
            's4a-mandate': 13.0, 's4b-arcscan': 3.5, 's4c-nonce': 8.5, 's5-forge': 9.0,
            's1-market': 9.0, 's2-seller': 12.0, 's6-evidence': 8.0}

def run(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def dur(p):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)]).decode().strip())

sections = []
total = 0.0
for take, items in TAKES:
    audio = VO / f'{take}.wav'
    if not audio.exists():
        sys.exit(f'missing {audio}')
    a = max(0.5, dur(audio) - 0.35)  # the first 0.35s is the input's power-on pop, trimmed below
    target = a + PAD
    # usable length of each item
    parts = []
    for kind, name in items:
        if kind == 'slide':
            parts.append({'kind': kind, 'name': name, 'start': 0.0, 'len': None})
        else:
            f = V / 'browser' / f'{name}.webm'
            s = float(marks.get(name, 0))
            parts.append({'kind': kind, 'name': name, 'start': s, 'len': dur(f) - s})
    if parts[0]['kind'] == 'slide':
        parts[0]['len'] = target
    else:
        natural = sum(p['len'] for p in parts)
        if natural > target:
            excess = natural - target
            # trim from the ends of clips, largest first, keeping at least 3s of each
            for p in sorted(parts, key=lambda p: -p['len']):
                keep = min(p['len'], MIN_KEEP.get(p['name'], 3.0))
                cut = min(excess, max(0.0, p['len'] - keep))
                p['len'] -= cut; excess -= cut
                if excess <= 0.01: break
        elif natural < target:
            parts[-1]['hold'] = target - natural
    seg_files = []
    for i, p in enumerate(parts):
        seg = W / f'{take}-{i}.mp4'
        if p['kind'] == 'slide':
            run('ffmpeg', '-y', '-loop', '1', '-t', f"{p['len']:.3f}", '-i', str(V / 'slides' / f"{p['name']}.png"),
                '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', str(seg))
        else:
            vf = 'fps=30,scale=1920:1080,format=yuv420p'
            if p.get('hold', 0) > 0:
                vf += f",tpad=stop_mode=clone:stop_duration={p['hold']:.3f}"
            run('ffmpeg', '-y', '-ss', f"{p['start']:.3f}", '-t', f"{p['len']:.3f}", '-i', str(V / 'browser' / f"{p['name']}.webm"),
                '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', str(seg))
        seg_files.append(seg)
    # concat this take's picture, then lay its audio on it (audio starts 0.15s in)
    lst = W / f'{take}.txt'
    lst.write_text(''.join(f"file '{s}'\n" for s in seg_files))
    pic = W / f'{take}-pic.mp4'
    run('ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(pic))
    sec = W / f'{take}-sec.mp4'
    run('ffmpeg', '-y', '-i', str(pic), '-i', str(audio),
        '-filter_complex', f"[1:a]atrim=start=0.35,asetpts=PTS-STARTPTS,highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,adelay=150|150,apad,atrim=0:{dur(pic):.3f},aformat=channel_layouts=stereo[a]",
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', str(sec))
    d = dur(sec); total += d
    sections.append((take, a, d))
    print(f'take {take:>2}: audio {a:5.1f}s  picture {d:5.1f}s')

lst = W / 'all.txt'
lst.write_text(''.join(f"file '{W / (t + '-sec.mp4')}'\n" for t, _, _ in sections))
run('ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(OUT))
final = dur(OUT)
print(f'\nexported {OUT}  {final:.1f}s ({int(final // 60)}:{int(final % 60):02d})')
if not (120 <= final <= 240):
    print('WARNING: outside the 2:00 to 4:00 window; ETHGlobal will reject the upload')
