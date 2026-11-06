# One Message: From Lightning to Language

A single continuous camera move that follows one chatbot reply from a lightning storm, through the power grid and a datacenter, down into a chip, through the math of a language model, and back out to the reply on a phone. Built with Three.js, TypeScript and Vite.

**Status: Module 1, the gray-box pacing spine.** One clock, one camera path, eight gray-box realms and 18 shots in 90 seconds. Every shape, count and height is a placeholder. The point of this module is to judge the pacing. Not in Module 1: portals between realms (each realm change fades through black instead), clicking objects, custom shaders, the tokenizer and the sandbox.

## Run it on a Mac

1. Open Terminal: press Cmd+Space, type `Terminal` and press Return.
2. Check that Node.js 20.19 or newer is installed:
   ```sh
   node -v
   ```
   If it prints `command not found` or a version below v20.19, install the LTS version from [nodejs.org](https://nodejs.org) (the macOS installer), then quit and reopen Terminal.
3. Get the code. Choose one way.
   - **With git:**
     ```sh
     git clone https://github.com/pmmhtsz57r-eng/Egrid.git
     cd Egrid
     ```
     If macOS offers to install the command line developer tools, accept, wait for it to finish, and run the two lines again. To try Module 1 before it is merged, also run `git checkout module-1-graybox`.
   - **Without git:** download the [module-1-graybox ZIP](https://github.com/pmmhtsz57r-eng/Egrid/archive/refs/heads/module-1-graybox.zip), open it from Downloads to unzip it, then:
     ```sh
     cd ~/Downloads/Egrid-module-1-graybox
     ```
4. Install the dependencies. You only need to do this once; it takes under a minute.
   ```sh
   npm install
   ```
5. Start it:
   ```sh
   npm run dev
   ```
   Open the address it prints, usually <http://localhost:5173>, in Chrome, Safari or Firefox. The 90 seconds start playing on their own.
6. To stop it, click the Terminal window and press Ctrl+C. To run it again later, `cd` into the folder and repeat step 5.

Optional checks: `npm test` checks the truth ledger, the shot table and the TypeScript types. `npm run build` runs the same checks, then makes a production build in `dist/`. The build warns that a chunk is over 500 kB; that chunk is mostly three.js, and the warning is expected.

## Controls

| To | Do this |
| --- | --- |
| Play or pause | Space or K, or the play button |
| Step back or forward 1 second | ← or → (or J and L). Hold Shift for 5 seconds |
| Jump to the previous or next shot | `[` or `]` |
| Jump to the start or end | Home or End |
| Scrub | Drag the bar, or scroll the mouse wheel over the scene (this pauses). Pinch or Ctrl+scroll still zooms the page |
| Step with the bar focused | ↑ or ↓ for 1 second, Page Up or Page Down for the next or previous shot |
| Look around | Pause, then drag on the scene. Press play and the camera glides back |
| Show the debug overlay | D |

Address options: `?t=34` starts at 34 seconds (a time inside a realm-change fade moves to just after it, so the first frame isn't black), `?autoplay=0` waits for Play, and `?debug` opens the overlay, for example <http://localhost:5173/?t=34&debug>. With Reduce motion turned on (System Settings → Accessibility → Display), it waits for Play, the lightning doesn't flash and the sampling wheel doesn't spin.

## The 90 seconds

| Shot | Starts | Length | Name | Caption |
| --- | --- | --- | --- | --- |
| 1 | 0:00 | 4 s | Storm | Every reply runs on electricity. |
| 2 | 0:04 | 4 s | Bolt becomes grid | Lightning is electricity untamed. The grid is the tamed kind. |
| 3 | 0:08 | 5 s | Grid ride | Generated far away, carried here at high voltage. |
| 4 | 0:13 | 4 s | Campus doors | A datacenter is a building designed around power and heat. |
| 5 | 0:17 | 5 s | Hall aisle | Thousands of servers. Nearly all their power ends up as heat. |
| 6 | 0:22 | 4 s | Into the rack | Inside: accelerators built to multiply and add numbers. |
| 7 | 0:26 | 4 s | Package | Memory is stacked right beside the processor, so data travels less. |
| 8 | 0:30 | 4 s | Die dive | Many compute units, working in parallel. |
| 9 | 0:34 | 5 s | Handoff | Zoom in far enough, and the work is arithmetic. |
| 10 | 0:39 | 5 s | Message to tokens | Your message arrives as text. First, it's cut into tokens. |
| 11 | 0:44 | 4 s | Embeddings | Each token becomes a long list of numbers. |
| 12 | 0:48 | 8 s | Attention | Attention: each token looks back, never ahead. |
| 13 | 0:56 | 6 s | Layers | The same structure repeats, layer after layer, with new weights. |
| 14 | 1:02 | 5 s | Logits | Out comes a score for every possible next token. |
| 15 | 1:07 | 5 s | Softmax | Softmax turns scores into probabilities. |
| 16 | 1:12 | 5 s | Sample | One is chosen. Just one. |
| 17 | 1:17 | 6 s | Return trip | Then the model runs again for each new token. |
| 18 | 1:23 | 7 s | Reply | One message. Every token, one trip through the machine. |

To change the pacing, edit a shot's `duration` in [`src/content/shots.json`](src/content/shots.json) and save; the page reloads by itself. Camera moves live in the same file as keys: `at` is a point in the shot from 0 to 1, `pos` is where the camera is and `target` is what it looks at. A realm change is two keys with the same `at`; a `fade` length goes on the second of them. If an edit breaks the path, the page lists the problems instead of playing, and `npm test` fails with the same list. That includes a path whose picture would jump: the check plays the path at 60 frames a second and refuses a frame where the view turns more than 10 degrees, which happens when the camera passes too close to, or over, what it looks at. It also refuses a frame where the camera moves more than 40% of its distance to its target, which happens when two keys are too close in time or a shot is too short for its move. Only frames that a realm-change fade has turned almost black are exempt.

## Truth ledger

[`src/content/ledger.json`](src/content/ledger.json) lists every claim the piece makes on screen. Each claim has a truth tag and sources:

- **Real**: measured, documented, or computed exactly as shown. Needs at least one citation.
- **Approximated**: true in kind, with shape, scale or detail simplified.
- **Simulated**: produced by this project's own code to illustrate. Needs an on-screen disclosure.
- **Metaphor**: a figure of speech or framing device. Needs an on-screen disclosure.

Every caption in `shots.json` must cite at least one claim and stay within 11 words. `npm test` and `npm run build` fail if any claim or explainable has no truth tag or no source, or if any of the rules above is broken. A citation carries a `checked` date only after someone opened that exact page and confirmed what its `supports` line says, so the lint also fails a `checked` date that isn't a real day, is later than the ledger's `updated` date, or comes without a `supports` line. The ledger has 31 claims, and all 60 citations were checked on 2026-11-06. The four remaining warnings are for files that later modules will build: the tokenizer, the simulator and the trace exporter. `npm run lint:ledger:strict` treats those warnings as errors.

Module 1 shows captions only. The badges and the inspector that carry each claim's disclosure on screen, such as "Simulated" and "time dilated", arrive with the modules that need them.

## Pinned tokenizer and model

Module 1 uses neither of these. Later modules must use exactly these versions.

| | Pin | License |
| --- | --- | --- |
| Tokenizer library | [`@huggingface/tokenizers`](https://github.com/huggingface/tokenizers.js) **0.2.0** exactly, published 2026-09-07, no dependencies | [Apache-2.0](https://github.com/huggingface/tokenizers.js/blob/main/LICENSE) |
| Open model | [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) at revision **`7ae557604adf67be50417f59c2c2f167def9a775`** (2024-09-25) | [Apache-2.0](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/main/LICENSE), Copyright 2024 Alibaba Cloud |

From the pinned `config.json`, whose git blob `0dbb161213629a23f0fc00ef286e6b1e366d180f` was checked against the revision's file tree:

- 24 layers.
- 14 attention heads sharing 2 key-value heads.
- 494 million parameters.
- An output layer of 151,936 scores. 151,665 of them are real tokens (151,643 learned pieces plus 22 added ones); the rest are padding.

Files to ship from the pinned revision:

| File | Bytes | Hash |
| --- | --- | --- |
| `tokenizer.json` | 7,031,645 | sha256 `c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539` |
| `tokenizer_config.json` | 7,305 | sha256 `5b5d4f65d0acd3b2d56a35b56d374a36cbc1c8fa5cf3b3febbbfabf22f359583` |
| `LICENSE` | 11,343 | git blob `6634c8cc3133b3848ec74b9f275acaaa1ea618ab` |

Apache-2.0 section 4 requires the LICENSE to travel with redistributed files. The weights (`model.safetensors`, 988,097,824 bytes, sha256 `fdf756fa7fcbe7404d5c60e26bff1a0c8b8aa1f72ced49e7dd0210fe288fb7fe`) never ship to the browser. Only the offline trace exporter uses them.

How the pins keep the approval rules:

- **The hero reply uses canned real traces.** They are exported offline from the pinned model with greedy decoding, eager attention and float32 weights. So its attention weights and its loop counter's token count are Real.
- **Typed text uses the real tokenizer.** The pinned library and the pinned tokenizer files run in the browser. Two independent research runs, with no network, compared it with Hugging Face's Rust and Python tokenizers in Node and headless Chrome. The token IDs matched on 4,038 and on 12,000 test strings. The exceptions are rare characters on which the two Unicode implementations disagree: 4,852 code points in 85 ranges. Most are recent additions such as CJK Extension J (U+323B0 to U+33479); the rest are some combining marks and the long s (ſ). The typed-text module must flag such input instead of implying its IDs match the model's.
- **Typed text never gets real attention.** Its attention and its loop count come from a labeled simulator, and the screen says Simulated.

Known pitfalls for the later modules:

- Hugging Face transformers' default `sdpa` attention returns no attention weights and only logs a warning, so the exporter must load the model with `attn_implementation="eager"`.
- The model's `generation_config` samples by default (temperature 0.7, top-p 0.8, top-k 20, repetition penalty 1.1). The hero trace uses greedy decoding. Any probabilities shown say whether they are raw softmax or after those settings.
- The chat template inserts a default system prompt that names Qwen and Alibaba Cloud, unless the conversation supplies its own. Typed text containing `<|im_end|>` becomes a single special token in both Python and JavaScript.
- The tokenizer data is 7.0 MB, or 1.9 MB gzipped. Load it lazily.
- Only Node and Chrome were tested. Firefox and Safari ship different Unicode tables, so they need the same parity test.
- If the browser ever renders the chat template, pin `@huggingface/jinja` to exactly 0.5.10 (MIT). It matched transformers' rendering in testing, and a newer version came out after the pinning cutoff.

The runner-up was `HuggingFaceTB/SmolLM2-360M-Instruct`. Its tokenizer is about a third of the size, but its repository has no LICENSE file, and its pre-tokenizer splits text containing a byte-order mark or U+0085 differently in JavaScript than in Rust.

## Project layout

| Path | What it is |
| --- | --- |
| `index.html` | The canvas and the on-screen controls |
| `src/main.ts` | Starts everything, runs the render loop and the debug overlay |
| `src/core/shots.ts` | Turns the shot table into one continuous camera path, and checks it |
| `src/core/timeline.ts` | The single clock and its controls |
| `src/core/cameraRig.ts` | Keeps the camera on the path; orbit while paused |
| `src/realms/graybox.ts` | The eight gray-box realms and their per-shot beats |
| `src/content/shots.json` | The 90-second spine: durations, captions and camera keys |
| `src/content/ledger.json` | The truth ledger |
| `tests/ledger-lint.mjs` | Lints the ledger and the captions (`--self-test`, `--strict`) |
| `tests/shot-table-check.mjs` | Builds the camera path from `shots.json` the way the page does, and fails on the same problems |

## Third-party licenses

three 0.186.1 (MIT), Vite 8.3.5 (MIT), TypeScript 5.9.3 (Apache-2.0) and @types/three 0.186.0 (MIT).
