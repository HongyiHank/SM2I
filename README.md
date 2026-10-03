# Song Maker MIDI Importer (SM²I)

Drop a `.mid` file straight into [Chrome Music Lab's Song Maker](https://musiclab.chromeexperiments.com/Song-Maker) — no clicking out the notes one by one.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) (Recommended) or [Tampermonkey](https://www.tampermonkey.net/).
2. Click [here](https://raw.githubusercontent.com/HongyiHank/SM2I/main/sm2i.user.js) to install the script
3. Open Song Maker and enjoy your music.

## Use

**Import** → **Choose MIDI file** → pick a file.

- 16 bars or fewer: imported straight away.
- Longer (Song Maker's ceiling): a clip picker appears on the page — drag a selection, or nudge it with the arrow keys — then **Import** brings in just that part.

The status line afterwards reports notes · bars · BPM, plus how many notes were dropped.

## How it works

One userscript, no backend: it rewrites the `.mid` in the browser into a shape Song Maker can actually draw, then uploads through Song Maker's own API.

| Step | What happens |
| --- | --- |
| Parse | Read events, tempo and time signature, pair note-on/off |
| Align | Quantize to 16th cells (240 ticks), octave-fold pitches into the grid's range, thin stacked chords to one note, map drums onto the page's 2 rows |
| Write | Build SMF format 1 by hand: 960 TPB, three tracks — conductor / melody (ch1) / drums (ch9) |
| Upload | `POST /Song-Maker/save` with `multipart/form-data`: `midi` plus `data` (bars, tempo, scale…) |
| Display | `history.pushState` swaps the URL and the page loads the song itself |

Preview playback is synthesized on the spot by the libraries below — nothing is uploaded until you confirm.

## Third-party projects used

| Role | Project |
| --- | --- |
| Parse MIDI, sample playback | [MidiPlayerJS](https://github.com/grimmdude/MidiPlayerJS) ([npm](https://www.npmjs.com/package/midi-player-js)) |
| Piano samples | [smplr](https://github.com/danigb/smplr) ([npm](https://www.npmjs.com/package/smplr)) |

## License

[Apache-2.0](https://github.com/HongyiHank/SM2I?tab=Apache-2.0-1-ov-file)