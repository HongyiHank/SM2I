// ==UserScript==
// @name         Song Maker MIDI Importer
// @namespace    csm.midi-importer
// @version      1.0.0
// @description  Direct MIDI file importer for Chrome Music Lab's Song Maker.
// @match        https://musiclab.chromeexperiments.com/Song-Maker*
// @license      Apache-2.0
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ---------------- pure core: .mid -> Song Maker song ---------------- */

  var TPB = 960;        // ticks per beat of the file we write
  var DIV = 4;          // subdivision: one grid cell = one 16th note
  var STEP = TPB / DIV; // 240 ticks
  var MAX_BARS = 16;    // <input name=bars max=16> in the page's settings modal
  // The page maps a drum pitch to one of just 2 rows with
  // [39,76,38,60].includes(note) ? 1 : 0  (@877561), and its own electronic kit
  // writes 39 for row 1 and 35 for row 0 (@874580). Snare (38) would land on row 1
  // too, so kick and snare would share a cell - write the page's own pair.
  var DRUM = { 35: 35, 36: 35, 41: 35,            // kick / low tom -> row 0
               37: 39, 38: 39, 39: 39, 40: 39 };   // snare / hand clap -> row 1

  // Both libraries ship native ESM with permissive CORS and the page sets no CSP.
  // Loaded on demand; the module cache means the second import is free.
  var midiPlayerURL = 'https://unpkg.com/midi-player-js/build/index.browser.js';
  var smplrURL = 'https://unpkg.com/smplr/dist/index.mjs';
  var libs = null;
  function loadLibs() {
    return libs || (libs = Promise.all([import(midiPlayerURL), import(smplrURL)])
      .then(function (m) { return { Player: m[0].default.Player, SplendidGrandPiano: m[1].SplendidGrandPiano }; }));
  }

  // One parse feeds the grid (note-on positions) and the preview (note lengths).
  // Notes pair on-to-off per track+channel+pitch; midi-player-js reports velocity 0-100.
  function readMidi(buf) {
    return loadLibs().then(function (L) {
      var player = new L.Player(function () {});
      player.loadArrayBuffer(buf);
      if (player.division & 0x8000) throw new Error('SMPTE timecodes are not supported.');
      var tracks = player.events || [], notes = [], beats = 0;
      if (!tracks.some(function (t) { return t.length; })) throw new Error('Not a MIDI file (no events found).');

      tracks.forEach(function (events, ti) {
        var open = {};
        events.forEach(function (e) {
          var k = ti + ':' + e.channel + ':' + e.noteNumber, st;
          if (e.name === 'Time Signature' && !beats) beats = parseInt(e.timeSignature, 10) || 0;
          else if (e.name === 'Note on' && e.velocity > 0) {
            // stack per key: a note struck twice before its off must not lose the first.
            // vel back to 0-127 (smplr's scale), from the note-ON; the off velocity is a release value.
            (open[k] || (open[k] = [])).push({ t: e.tick, vel: Math.max(1, Math.round(e.velocity / 100 * 127)), drum: e.channel === 10 });
          } else if ((e.name === 'Note off' || e.name === 'Note on') && open[k] && open[k].length) {
            st = open[k].shift();   // 'Note on' here is velocity 0, i.e. running-status note-off
            notes.push({ t: st.t, d: e.tick - st.t, pitch: e.noteNumber, vel: st.vel, drum: st.drum });
          }
        });
        // unclosed notes: keep them one beat long rather than drop them
        Object.keys(open).forEach(function (k) {
          open[k].forEach(function (st) {
            notes.push({ t: st.t, d: player.division, pitch: +k.split(':')[2], vel: st.vel, drum: st.drum });
          });
        });
      });
      notes.sort(function (a, b) { return a.t - b.t; });
      return {
        division: player.division, notes: notes, beats: Math.min(7, Math.max(2, beats || 4)),
        bpm: Math.min(300, Math.max(30, Math.round((player.tempoMap[0] || {}).tempo || player.tempo || 120)))
      };
    });
  }

  var rows = function (octaves) { return 12 * octaves + (octaves === 1 ? 1 : 0); };
  var secPerTick = function (mid) { return 60 / mid.bpm / mid.division; };

  // where the notes are, and whether they all fit the grid in one go
  function planSong(mid) {
    var first = Infinity, last = 0, i, t;
    for (i = 0; i < mid.notes.length; i++) {
      t = mid.notes[i].t;
      if (t < first) first = t;
      if (t > last) last = t;
    }
    if (!isFinite(first)) throw new Error('No playable notes in this file.');
    var beats = mid.beats;
    var bar = Math.max(1, Math.round(beats * mid.division)); // ticks per bar
    var total = (Math.floor((last - first) / bar) + 1) * bar;
    return { beats: beats, bar: bar, first: first, total: total,
             span: MAX_BARS * bar, fits: total <= MAX_BARS * bar };
  }

  // build the grid contents for the source range [from, to) - ticks are counted
  // from `from`, so a clip starting mid-song still lines up with the 16th grid.
  function buildSong(mid, from, to) {
    var beats = mid.beats;
    var q = mid.division / DIV;
    var sel = [], i, n, lo = 127, hi = 0;
    var lost = { drums: 0, tight: 0, octaves: 0 };

    for (i = 0; i < mid.notes.length; i++) {
      n = mid.notes[i];
      if (n.t < from || n.t >= to) continue;
      if (n.drum) {
        if (DRUM[n.pitch]) sel.push({ c: Math.round((n.t - from) / q), d: 1, p: DRUM[n.pitch] });
        else lost.drums++;                    // hats, cymbals, toms: the grid has 2 rows
      } else {
        sel.push({ c: Math.round((n.t - from) / q), d: 0, p: n.pitch });
        if (n.pitch < lo) lo = n.pitch;
        if (n.pitch > hi) hi = n.pitch;
      }
    }
    if (!sel.length) throw new Error('No playable notes in the selected part.');

    // Grid rows are rootNote..rootNote+rows-1 (36 at most); the page drops
    // anything outside and keeps only one note per cell.
    var octaves = 1;
    while (octaves < 3 && hi - lo + 1 > rows(octaves)) octaves++;
    var top = rows(octaves);
    var rootNote = Math.max(12, lo - Math.floor((top - (hi - lo + 1)) / 2));
    var bars = Math.min(MAX_BARS, Math.max(1, Math.ceil((to - from) / (q * beats * DIV))));
    var limit = bars * beats * DIV;

    // A span wider than the window can only be folded by octave, and folding
    // collides: a bass note and a melody note R semitones apart land on the
    // same row and one of them is deleted. Instead give every simultaneous
    // note of a pitch class its own octave slot, nearest free one first, so a
    // note is only ever dropped when the grid is genuinely full.
    var mod = function (a, n) { return ((a % n) + n) % n; };
    var taken = {}, mel = [], perc = [], key, d, co, n1, s, k, u, free;
    for (i = 0; i < sel.length; i++) {
      n = sel[i];
      if (n.c >= limit) { lost.tight++; continue; }
      if (n.d) {
        key = n.c + ':' + n.p;
        if (taken[key]) { lost.tight++; continue; }
        taken[key] = 1;
        perc.push({ c: n.c, p: n.p });
        continue;
      }
      d = n.p - rootNote;
      co = mod(d, 12);                        // this pitch class, octave 0
      n1 = ((top - 1 - co) / 12 | 0) + 1;     // octave slots of it the window holds
      s = mod(Math.floor(d / 12), n1);        // preferred slot
      free = -1;
      for (k = 0; k < n1 && free < 0; k++) {  // nearest free slot, below then above
        if (!taken[n.c + ':' + co + ':' + (u = mod(s - k, n1))]) free = u;
        else if (!taken[n.c + ':' + co + ':' + (u = mod(s + k, n1))]) free = u;
      }
      if (free < 0) { lost.octaves++; continue; }
      taken[n.c + ':' + co + ':' + free] = 1;
      mel.push({ c: n.c, p: rootNote + co + 12 * free });
    }

    return {
      options: {
        bars: bars, beats: beats, subdivision: DIV, octaves: octaves,
        scale: 'chromatic', rootNote: rootNote,
        rootPitch: rootNote % 12, rootOctave: Math.floor(rootNote / 12),
        instrument: 'piano', percussion: 'electronic', percussionNotes: 2,
        tempo: mid.bpm
      },
      melody: mel, drums: perc, lost: lost, totalTicks: limit * STEP
    };
  }

  function writeMidi(song) {
    var vlq = function (n) {
      var out = [n & 0x7f];
      for (n = (n / 128) | 0; n > 0; n = (n / 128) | 0) out.push((n & 0x7f) | 0x80);
      return out.reverse();
    };
    var chunk = function (body) {
      return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255,
              (body.length >>> 8) & 255, body.length & 255].concat(body);
    };
    var track = function (events, total) {
      var body = [], last = 0, i;
      events.sort(function (a, b) { return a.t - b.t || a.o - b.o; }); // offs before ons
      for (i = 0; i < events.length; i++) {
        vlq(events[i].t - last).forEach(function (v) { body.push(v); });
        body.push.apply(body, events[i].d);
        last = events[i].t;
      }
      vlq(Math.max(0, total - last)).forEach(function (v) { body.push(v); });
      body.push(0xff, 0x2f, 0x00);
      return chunk(body);
    };
    // Song Maker plays every note as one 16th, so duration is always 1 cell.
    // melody on ch1, percussion on ch10 - the layout the page itself writes.
    var seq = function (list, chan) {
      var out = [], i;
      for (i = 0; i < list.length; i++) {
        out.push({ t: list[i].c * STEP, o: 1, d: [0x90 | chan, list[i].p, 100] });
        out.push({ t: (list[i].c + 1) * STEP, o: 0, d: [0x80 | chan, list[i].p, 0] });
      }
      return out;
    };

    var us = Math.round(6e7 / song.options.tempo);
    var bytes = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, TPB >> 8, TPB & 255]
      .concat(track([{ t: 0, o: 0, d: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] }], song.totalTicks))
      .concat(track([{ t: 0, o: 0, d: [0xc1, 0x00] }].concat(seq(song.melody, 1)), song.totalTicks))
      .concat(track(seq(song.drums, 9), song.totalTicks));
    return new Uint8Array(bytes);
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { readMidi: readMidi, planSong: planSong, buildSong: buildSong, writeMidi: writeMidi };
    return;
  }

  /* ---------------- preview ---------------- */

  var actx = null, voice = null, voiceKey = '', playing = null, cancels = [];

  // smplr's piano ships five sample layers split by velocity: PPP 1-40, PP 41-67,
  // MP 68-84, MF 85-100, FF 101-127. Asking for a range touching several of them
  // multiplies the sample downloads, and a voice whose sample failed to arrive is
  // dropped in silence (smplr skips it), so a wide range quietly loses most of the
  // music. Load one layer and scale the clip's velocities onto it.
  // MF for every file - widen to two layers when one timbre stops being
  // enough to judge a clip, and expect the fetch count to double with it.
  var LAYER = [85, 100];
  function audio() { return actx || (actx = new (window.AudioContext || window.webkitAudioContext)()); }

  function playPreview(mid, from, to, onTick, onEnd) {
    stopPreview();
    var mine = gen;                  // the selection this preview belongs to
    var ctx = audio();
    if (ctx.state === 'suspended') ctx.resume();
    var spb = secPerTick(mid);
    var pitches = [], seen = {}, vel = [127, 1], i, n, dur;

    // The clip's velocity range, needed to scale it onto the one layer we load.
    for (i = 0; i < mid.notes.length; i++) {
      n = mid.notes[i];
      if (n.drum || n.t < from || n.t >= to) continue;
      if (!seen[n.pitch]) { seen[n.pitch] = 1; pitches.push(n.pitch); }
      if (n.vel < vel[0]) vel[0] = n.vel;
      if (n.vel > vel[1]) vel[1] = n.vel;
    }
    if (!pitches.length) vel = [100, 100];   // nothing to play, nothing to pick

    return loadLibs().then(function (L) {
      // Samples come over the network, so keep one piano per pitch set instead of
      // rebuilding it every play. SplendidGrandPiano is one ~65 kB file per pitch
      // rather than one 2.3 MB kit, and falls back to the nearest loaded key, so
      // a clip using a handful of pitches stays a handful of files.
      var key = pitches.join(',') + '|' + vel.join('-');
      if (!voice || voiceKey !== key) {
        if (voice) voice.dispose();
        voice = L.SplendidGrandPiano(ctx, {
          decayTime: 0.4,
          // Loudness: a note's gain is (velocity/127)^2 and the master is
          // (volume/127)^2, so the loudest note lands at (vel * volume)^2. Holding
          // that one level across files means volume has to fall as the clip's
          // loudest velocity rises - 12700 is 127 * the library default of 100, so
          // a file that already peaks at 127 is left alone. Capped at 200: past
          // +6 dB of makeup you are lifting the noise floor, not the music.
          volume: Math.min(200, Math.round(12700 / vel[1])),
          notesToLoad: { notes: pitches, velocityRange: LAYER }
        });
        voiceKey = key;
      }
      return voice.ready;
    }).then(function () {
      // Nothing is scheduled until the samples have landed: Web Audio starts a
      // source with a past `when` immediately, so an early t0 would collapse the
      // opening of the clip into one pile-up on ctx.currentTime. `gen` checked
      // here too - if the selection moved while this was loading, returning is
      // all it may do. Starting notes, or stopping whatever is playing now, from
      // a retired preview would be the lie: the newest one owns the voice.
      if (gen !== mine) return;
      var t0 = ctx.currentTime + 0.15;
      var span = Math.max(0.001, (to - from) * spb);
      // Scale the clip's velocities onto LAYER. A velocity outside every loaded
      // layer matches no group, and smplr returns without a word - that is the
      // silence, not a quiet note. A flat clip keeps the middle of the window.
      var sc = vel[1] > vel[0] ? (LAYER[1] - LAYER[0]) / (vel[1] - vel[0]) : 0;
      voice.stop();
      for (i = 0; i < mid.notes.length; i++) {
        n = mid.notes[i];
        if (n.drum || n.t < from || n.t >= to) continue;
        dur = Math.min(4, Math.max(0.05, n.d * spb));  // notes held >4s are cut
        // smplr queues anything more than 200 ms out and drains it every 50 ms;
        // voice.stop() only reaches voices that already started, so a stop would
        // leave the rest of the clip queued and still playing. The handle this
        // returns is the only way to pull a queued note back out.
        cancels.push(voice.start({ note: n.pitch, velocity: Math.round(LAYER[0] + (n.vel - vel[0]) * sc),
                                   time: t0 + (n.t - from) * spb, duration: dur }));
      }
      var job = { raf: 0 };
      playing = job;
      job.raf = requestAnimationFrame(function loop() {
        if (gen !== mine || playing !== job) return;   // retired: the newest preview owns the voice
        var x = (ctx.currentTime - t0) / span;
        if (x >= 1) { stopPreview(); onEnd(); return; }
        onTick(Math.max(0, x));
        job.raf = requestAnimationFrame(loop);
      });
    });
  }

  function stopPreview() {
    if (playing) cancelAnimationFrame(playing.raf);
    playing = null;
    // No early exit on `playing`: the preview can be mid-load, with the voice
    // already audible and the raf loop not started yet.
    for (var i = 0; i < cancels.length; i++) { try { cancels[i](); } catch (e) {} }
    cancels = [];
    if (voice) { try { voice.stop(); } catch (e) {} }
  }

  /* ---------------- UI ---------------- */

  var HINT = 'Please try to upload a simple, single-instrument MIDI file.';

  var style = document.createElement('style');
  style.textContent =
    '#sm-import-panel{position:absolute;bottom:100%;right:20px;z-index:60;width:270px;padding:14px 16px;' +
    'border:1px solid #e6e6e6;border-radius:4px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.18);' +
    'font-family:"Poppins",sans-serif;font-size:13px;line-height:1.5;text-align:left;color:#666}' +
    '#sm-import-hint{margin:0 0 10px}' +
    '#sm-import-upload{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;' +
    'border:1px solid #16a8f0;border-radius:4px;color:#16a8f0;background:#fff;cursor:pointer;user-select:none}' +
    '#sm-import-upload:hover{background:#eaf6fd}' +
    '#sm-import-upload .material-symbols-outlined{font-size:20px}' +
    '#sm-import-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}' +
    '#sm-import-status{margin:10px 0 0;min-height:1em;color:#666}' +
    '#sm-import-status.err{color:#d33}' +
    // upload glyph in the same round icon slot the page uses for Midi/Mic/Save
    '#bottom #sm-import-button:before{content:"upload";font-family:"Material Symbols Outlined";' +
    'font-weight:400;font-style:normal;font-size:34px;text-align:center;color:#666;' +
    '-webkit-font-feature-settings:"liga";font-feature-settings:"liga"}' +
    '#bottom #sm-import-button:hover:before{color:#16a8f0}' +
    '@media(min-width:768px)and(max-width:959px){#bottom #sm-import-button:before{font-size:26px}}' +
    '@media(max-width:767px){#sm-import-button{top:13px;left:24vw}' +
    '#bottom #sm-import-button:before{font-size:24px}}' +
    '@media(max-width:495px){#sm-import-button{top:65px;left:20vw}}' +
    /* clip picker - page tokens: $blue #16a8f0, $background-gray #f5f5f5, gray #666 */
    '#sm-clip{position:fixed;top:0;left:0;width:100%;height:100%;z-index:200;display:flex;' +
    'align-items:center;justify-content:center;background:rgba(245,245,245,.55);' +
    '-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px);font-family:"Poppins",sans-serif;' +
    'letter-spacing:.1ex;color:#666}' +
    '#sm-clip[hidden]{display:none}' +
    '#sm-clip-card{width:520px;max-width:calc(100% - 40px);box-sizing:border-box;background:#fff;' +
    'border-radius:6px;padding:26px 30px 22px;box-shadow:0 4px 20px rgba(0,0,0,.2);text-align:left}' +
    '#sm-clip-card h2{margin:0 0 4px;font-size:19px;font-weight:600;color:#666}' +
    '#sm-clip-card p{margin:0;font-size:13px;line-height:1.5}' +
    '#sm-clip-row{display:flex;align-items:center;gap:18px;margin:18px 0 4px}' +
    '#sm-clip-play{width:56px;height:56px;flex:0 0 56px;border:0;border-radius:28px;cursor:pointer;' +
    'background:#16a8f0;color:#fff;box-shadow:1px 1px 1px 1px rgba(0,0,0,.2);' +
    'display:flex;align-items:center;justify-content:center}' +
    '#sm-clip-play:hover{background:#57c1f9}' +
    '#sm-clip-play .material-symbols-outlined{font-size:30px}' +
    '#sm-clip-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;font-size:13px;color:#666}' +
    // The strip is the whole file, with the part to import drawn over it. The
    // edges are real elements with a generous hit box, so there is nothing to miss.
    // touch-action:none and user-select:none are what keep the browser's own
    // gestures out of this one. No horizontal padding: the band and the handles
    // are absolutely positioned, so a percentage resolves against this box's own
    // width, and padding here would put the drawing and the hit test on two scales.
    '#sm-clip-track{position:relative;height:38px;box-sizing:border-box;' +
    'background:#f5f5f5;border-radius:4px;cursor:pointer;touch-action:none;' +
    'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
    '#sm-clip-track:focus{outline:2px solid #16a8f0;outline-offset:2px}' +
    '#sm-clip-band{position:absolute;top:4px;bottom:4px;background:#16a8f0;border-radius:4px;cursor:grab}' +
    '#sm-clip-band:active{cursor:grabbing}' +
    // a class, not an id: the handles are sm-clip-grip-l and sm-clip-grip-r, and a
    // #sm-clip-grip rule matches nothing, leaving them static and their inline
    // left ignored - nothing to grab
    '.sm-grip{position:absolute;top:-2px;bottom:-2px;width:16px;cursor:ew-resize;background:none;border:0;padding:0}' +
    '.sm-grip:after{content:"";position:absolute;top:5px;bottom:5px;left:5px;right:5px;' +
    'border-radius:2px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.25)}' +
    '.sm-grip:focus-visible{outline:2px solid #fff;outline-offset:1px}' +
    '#sm-clip-head{position:absolute;top:0;bottom:0;width:2px;background:#fff;opacity:0;' +
    'box-shadow:0 0 0 1px rgba(0,0,0,.2);pointer-events:none}' +
    '#sm-clip-head.on{opacity:1}' +
    '#sm-clip-ticks{display:flex;justify-content:space-between;margin-top:5px;font-size:11px;' +
    'color:#9e9e9e;font-variant-numeric:tabular-nums}' +
    '#sm-clip-state{color:#9e9e9e;font-size:12px}' +
    '#sm-clip-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:20px}' +
    '.sm-pill{font-family:inherit;font-size:13px;letter-spacing:.1ex;text-transform:uppercase;' +
    'padding:11px 24px;border:0;border-radius:25px;cursor:pointer;color:#fff;background:#16a8f0;' +
    'box-shadow:1px 1px 1px 1px rgba(0,0,0,.2)}' +
    '.sm-pill:hover{background:#57c1f9}' +
    '.sm-pill.ghost{background:#fff;color:#666}' +
    '.sm-pill.ghost:hover{background:#f5f5f5}';
  document.head.appendChild(style);

  var font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=upload,play_arrow,pause';
  document.head.appendChild(font);

  var panel = document.createElement('div');
  panel.id = 'sm-import-panel';
  panel.hidden = true;
  panel.innerHTML =
    '<p id="sm-import-hint"></p>' +
    '<label id="sm-import-upload" for="sm-import-file">' +
      '<span class="material-symbols-outlined">upload</span>Choose MIDI file</label>' +
    '<input id="sm-import-file" type="file" accept=".mid,.midi,audio/midi,audio/x-midi">' +
    '<p id="sm-import-status"></p>';
  panel.querySelector('#sm-import-hint').textContent = HINT;

  var statusEl = panel.querySelector('#sm-import-status');
  var fileEl = panel.querySelector('#sm-import-file');
  var say = function (msg, isErr) {
    statusEl.textContent = msg;
    statusEl.className = isErr ? 'err' : '';
  };

  var button = document.createElement('button');
  button.id = 'sm-import-button';
  button.className = 'button';
  button.textContent = 'Import';
  button.addEventListener('click', function (e) {
    e.preventDefault();
    panel.hidden = !panel.hidden;
  });

  /* ---- clip picker ---- */

  var clip = document.createElement('div');
  clip.id = 'sm-clip';
  clip.hidden = true;
  clip.setAttribute('role', 'dialog');
  clip.setAttribute('aria-modal', 'true');
  clip.setAttribute('aria-labelledby', 'sm-clip-title');
  clip.innerHTML =
    '<div id="sm-clip-card">' +
      '<h2 id="sm-clip-title">This file is longer than Song Maker can hold</h2>' +
      '<p id="sm-clip-sub"></p>' +
      '<div id="sm-clip-row">' +
        '<button id="sm-clip-play" aria-label="Play the part to import">' +
          '<span class="material-symbols-outlined" id="sm-clip-icon">play_arrow</span></button>' +
        '<div id="sm-clip-info">' +
          '<div id="sm-clip-track" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="0"' +
            ' aria-valuenow="0" aria-label="Part to import. Drag an edge to set it, drag the middle to' +
            ' move it. Arrow keys move it, shift with the arrow keys changes its length.">' +
            '<div id="sm-clip-band"></div>' +
            '<button id="sm-clip-grip-l" class="sm-grip" aria-label="Start of the part"></button>' +
            '<button id="sm-clip-grip-r" class="sm-grip" aria-label="End of the part"></button>' +
            '<div id="sm-clip-head"></div>' +
          '</div>' +
          '<div id="sm-clip-ticks"><span id="sm-clip-from">0:00</span>' +
            '<span id="sm-clip-total"></span></div>' +
          '<span id="sm-clip-len"></span>' +
          '<span id="sm-clip-state"></span></div>' +
      '</div>' +
      '<div id="sm-clip-actions">' +
        '<button class="sm-pill ghost" id="sm-clip-cancel">Cancel</button>' +
        '<button class="sm-pill" id="sm-clip-ok">Import part</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(clip);

  var q = function (id) { return clip.querySelector('#' + id); };
  var playBtn = q('sm-clip-play'), playIcon = q('sm-clip-icon'), lenEl = q('sm-clip-len');
  var stateEl = q('sm-clip-state'), subEl = q('sm-clip-sub'), okBtn = q('sm-clip-ok');
  var cancelBtn = q('sm-clip-cancel'), track = q('sm-clip-track'), band = q('sm-clip-band');
  var gripL = q('sm-clip-grip-l'), gripR = q('sm-clip-grip-r'), head = q('sm-clip-head');
  var fromOut = q('sm-clip-from'), totalEl = q('sm-clip-total');

  var mmss = function (sec) {
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  // The chosen part, as bar numbers from 0. `len` is the number the user chose
  // deliberately, so moving the block never changes it: it slides back inside
  // the file instead. That keeps every reachable selection on bar lines and
  // between 1 and 16 bars, whichever edge or key got there.
  var sel = null;  // { mid, plan, bars, spb, start, len, resolve }

  function selRange() {
    return [sel.plan.first + sel.start * sel.plan.bar,
            sel.plan.first + (sel.start + sel.len) * sel.plan.bar];
  }

  // The only place the selection is written, so no caller can reach 0 bars or run
  // past either end of the file: `start` is clamped last, against the length that
  // came out of the length clamp.
  function put(start, len) {
    sel.len = Math.max(1, Math.min(MAX_BARS, sel.bars, Math.round(len)));
    sel.start = Math.max(0, Math.min(sel.bars - sel.len, Math.round(start)));
    render();
  }

  // every change to the selection retires the preview of the part left behind
  function after() { if (!sel) return; stopPlay(); render(); }

  // Which bar of the file a pixel falls in. The band and the handles are absolutely
  // positioned children of the track, so their percentages are resolved against
  // the track's own box: the same box this reads, or a handle would not be where
  // its hit test says it is.
  function barAt(x) {
    var r = track.getBoundingClientRect();
    return Math.max(0, Math.min(sel.bars - 1, Math.round((x - r.left) / r.width * sel.bars)));
  }

  /* Drag one edge to bar `b` and keep it there.
     Resizing moves the edge you are holding and pins the other one, so a short
     drag trims. When there is no room left to resize from that side - the edge
     would need 0 bars, or more than Song Maker's 16 - the block slides instead,
     with its length unchanged. So one gesture is trim first and move afterwards,
     the dragged edge stops where there is nothing left to slide into rather than
     vanishing or flipping to the other side, and no code path produces an empty
     selection. */
  function edgeTo(side, b) {
    var at = side === 'start' ? sel.start : sel.start + sel.len - 1;
    var len = sel.len + (side === 'start' ? at - b : b - at);
    if (len < 1 || len > MAX_BARS) {
      len = sel.len;
      put(side === 'start' ? b : b - sel.len + 1, len);
    } else {
      put(side === 'start' ? b : sel.start, len);
    }
    after();
  }

  function move(d) { put(sel.start + d, sel.len); after(); }

  // a focused handle's own edge, one bar at a time: the same rule as the pointer,
  // so it trims while there is room to trim and slides once there is not
  function nudgeEdge(side, d) {
    edgeTo(side, (side === 'start' ? sel.start : sel.start + sel.len - 1) + d);
  }

  /* Shift with an arrow changes the LENGTH of the part. The end edge does it by
     preference; when it has nowhere to go - the part is already as long as Song
     Maker takes, or it sits against the end of the file - the length changes
     from the other side, and a part that cannot change length at all moves along
     the file instead. Nothing is ever stuck, and every arrow that could mean
     something does something. */
  function resizeKey(d) {
    var last = sel.start + sel.len - 1;
    if (d < 0) {
      if (sel.len > 1) edgeTo('end', last - 1);   // shorten from the end, the start stays put
      else move(-1);                              // one bar is the shortest part there is
    } else if (sel.len < MAX_BARS) {
      edgeTo(last < sel.bars - 1 ? 'end' : 'start', last < sel.bars - 1 ? last + 1 : sel.start - 1);
    } else {
      move(1);                                    // already the longest part there can be
    }
  }

  function render() {
    var r = selRange(), a = (r[0] - sel.plan.first) * sel.spb, b = (r[1] - sel.plan.first) * sel.spb;
    var one = sel.len > 1 ? 's' : '', pct = 100 / sel.bars;
    band.style.left = (sel.start * pct) + '%';
    band.style.width = (sel.len * pct) + '%';
    // the handles straddle the band edge, so centre them on it
    gripL.style.left = 'calc(' + (sel.start * pct) + '% - 6px)';
    gripR.style.left = 'calc(' + ((sel.start + sel.len) * pct) + '% - 10px)';
    fromOut.textContent = mmss(a);
    totalEl.textContent = mmss(b) + ' of ' + mmss(sel.plan.total * sel.spb);
    lenEl.textContent = 'Bars ' + (sel.start + 1) + '-' + (sel.start + sel.len) +
      ' · ' + sel.len + ' bar' + one + ' · ' + sel.plan.beats + '/4 · ' + sel.mid.bpm + ' BPM';
    track.setAttribute('aria-valuemin', '1');
    track.setAttribute('aria-valuemax', String(sel.bars));
    track.setAttribute('aria-valuenow', String(sel.start + 1));
    track.setAttribute('aria-valuetext', 'bars ' + (sel.start + 1) + ' to ' + (sel.start + sel.len) +
      ', ' + sel.len + ' bar' + one + ', ' + mmss(a) + ' to ' + mmss(b));
  }

  // `gen` retires a preview whose selection moved on: the sample fetch is
  // async, so stopping the audio before it starts would be a lie.
  var busy = false, gen = 0;
  function stopPlay() {
    busy = false;
    gen++;
    stopPreview();
    head.className = '';
    playIcon.textContent = 'play_arrow';
    stateEl.textContent = '';
  }

  function togglePlay() {
    if (!sel) return;
    if (busy) { stopPlay(); return; }
    var mine = gen, r = selRange(), dur = (r[1] - r[0]) * sel.spb;
    busy = true;
    playIcon.textContent = 'pause';
    stateEl.textContent = 'loading samples...';
    playPreview(sel.mid, r[0], r[1], function (x) {
      if (mine !== gen) return;                   // a newer preview owns the voice
      head.className = 'on';
      head.style.left = ((sel.start + x * sel.len) * 100 / sel.bars) + '%';
      stateEl.textContent = 'playing ' + mmss(x * dur) + ' / ' + mmss(dur);
    }, function () { if (mine === gen) stopPlay(); }).catch(function (err) {
      if (mine !== gen) return;
      stopPlay();
      stateEl.textContent = 'preview failed: ' + (err.message || err);
    });
  }

  function finish(answer) {
    if (!sel) return;
    stopPlay();
    endDrag();
    var done = sel.resolve;
    sel = null;
    clip.hidden = true;
    done(answer);
  }

  /* ---- dragging ----
     One delegated pointerdown on the track, pointermove/up on window for the
     life of the gesture. preventDefault on pointerdown is what stops the
     browser starting a text selection or a drag ghost, which would otherwise
     swallow the pointermove stream mid-gesture; `touch-action:none` on the track
     does the same for touch, and it holds for the whole gesture from that first
     pointerdown even if the pointer leaves the strip. No pointer capture: it is
     the one piece that can silently fail, and window listeners already cover
     every case. */

  var drag = null;

  function beginDrag(e, part) {
    if (drag) return;                  // one gesture at a time: a second finger does not hijack it
    stopPlay();
    drag = { part: part, anchor: part === 'move' ? barAt(e.clientX) - sel.start : 0 };
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  function onDrag(e) {
    if (!drag || !sel) return;
    var b = barAt(e.clientX);
    if (drag.part === 'move') put(b - drag.anchor, sel.len);   // the middle moves the block only
    else edgeTo(drag.part, b);
  }

  function endDrag() {
    drag = null;
    window.removeEventListener('pointermove', onDrag);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  }

  track.addEventListener('pointerdown', function (e) {
    if (!sel || e.button > 0 || e.isPrimary === false) return;
    e.preventDefault();                    // no selection, no drag ghost
    var grip = e.target.closest && e.target.closest('.sm-grip');
    if (grip === gripL) { gripL.focus(); beginDrag(e, 'start'); }
    else if (grip === gripR) { gripR.focus(); beginDrag(e, 'end'); }
    else if (e.target === band) { track.focus(); beginDrag(e, 'move'); }
    else {
      track.focus();
      // a press on the strip outside the block takes whichever edge is nearer
      var b = barAt(e.clientX);
      beginDrag(e, b - sel.start <= sel.start + sel.len - 1 - b ? 'start' : 'end');
    }
  });
  track.addEventListener('keydown', function (e) {
    if (!sel || e.altKey || e.ctrlKey || e.metaKey) return;
    var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    if (e.key === 'Home') move(-sel.start);
    else if (e.key === 'End') move(sel.bars);
    else if (e.shiftKey) resizeKey(d);
    else move(d);
  });

  // A focused handle drives its own edge, so the arrows on the left one resize
  // from the left instead of sliding the block. Enter/Space trims the selection
  // down to that edge - one bar - the only single-key meaning a handle has, and
  // the arrows get it back again.
  [gripL, gripR].forEach(function (grip, i) {
    grip.addEventListener('keydown', function (e) {
      if (!sel) return;
      var side = i ? 'end' : 'start';
      var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
            : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();                  // and not the button's own click
      e.stopPropagation();                 // the track's arrows must not run as well
      if (d) nudgeEdge(side, d);
      else { put(side === 'start' ? sel.start : sel.start + sel.len - 1, 1); after(); }
    });
  });

  playBtn.addEventListener('click', togglePlay);
  okBtn.addEventListener('click', function () { if (sel) finish(selRange()); });
  cancelBtn.addEventListener('click', function () { finish(null); });
  clip.addEventListener('click', function (e) { if (e.target === clip) finish(null); });
  clip.addEventListener('keydown', function (e) { if (e.key === 'Escape') finish(null); });

  // resolves [from, to) in source ticks, or null if the user backs out
  function choosePart(mid) {
    var plan = planSong(mid);
    if (plan.fits) return Promise.resolve([plan.first, plan.first + plan.total]);

    return new Promise(function (resolve) {
      sel = { mid: mid, plan: plan, bars: Math.round(plan.total / plan.bar),
              spb: secPerTick(mid), start: 0, len: Math.min(MAX_BARS, Math.round(plan.total / plan.bar)),
              resolve: resolve };
      subEl.textContent = 'Drag to pick ' + MAX_BARS + ' bars. The file has ' + sel.bars + ' bars.';
      render();
      clip.hidden = false;
      track.focus();
    });
  }

  /* ---- import ---- */

  function importRange(mid, from, to) {
    var song = buildSong(mid, from, to);
    say('Uploading…');
    var form = new FormData();
    form.append('midi', new Blob([writeMidi(song)], { type: 'audio/midi' }), 'song.mid');
    form.append('data', JSON.stringify(song.options));
    return fetch('/Song-Maker/save', { method: 'POST', body: form })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.error || 'Save failed.');
        // The page watches location.pathname every frame and loads the song
        // itself, so the grid updates here - same tab, no window, no URL.
        history.pushState({}, 'Song ' + json.id, '/Song-Maker/song/' + json.id);
        // pushState load fills the timeline without touching tc(), so the
        // page never enables Save itself - unlock it, the song is already in.
        var saveBtn = document.getElementById('save-button');
        if (saveBtn) saveBtn.removeAttribute('disabled');
        var why = [];
        if (song.lost.octaves) why.push(song.lost.octaves + ' beyond 3 octaves of range');
        if (song.lost.tight) why.push(song.lost.tight + ' sharing a 16th cell');
        if (song.lost.drums) why.push(song.lost.drums + ' drum hits the 2 rows cannot hold');
        say('Loaded ' + (song.melody.length + song.drums.length) + ' notes · ' +
            song.options.bars + ' bars · ' + song.options.tempo + ' BPM' +
            (why.length ? ' · skipped ' + why.join(', ') : ''));
      });
  }

  fileEl.addEventListener('change', function () {
    var file = fileEl.files[0];
    if (!file) return;
    say('Reading ' + file.name + '…');
    file.arrayBuffer()
      .then(readMidi)
      .then(function (mid) {
        return choosePart(mid).then(function (range) {
          return range && importRange(mid, range[0], range[1]);
        });
      })
      .catch(function (err) { say(err.message || String(err), true); })
      .then(function () { fileEl.value = ''; });
  });

  var attach = function () {
    if (button.isConnected) return true;
    var midi = document.getElementById('midi-button');
    if (!midi) return false;
    midi.parentNode.insertBefore(button, midi);
    (document.getElementById('bottom') || document.body).appendChild(panel);
    return true;
  };

  if (!attach()) {
    var observer = new MutationObserver(function () { if (attach()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();