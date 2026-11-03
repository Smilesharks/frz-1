# FRZ-1

A Figma plugin that freezes a frame. It makes a copy of the selected frame and detaches every component instance inside the copy, including nested ones. You keep an editable snapshot of the design as it looks today, with no links back to the components you are still changing.

![FRZ-1 plugin window next to a before and after diagram: nested instances shown in purple become plain frames](docs/cover.png)

## About

When you iterate on components, every change spreads to every design that uses them. Most of the time that is exactly what you want. It also means older stages of a design disappear: the frame you showed last week now looks like this week.

FRZ-1 records those stages. Select a frame, press **Freeze**, and the plugin places a frozen copy next to it. The copy has the same layers and looks identical, but every instance in it is now a plain frame. Collect the frozen copies on a page of their own and you get a record of the whole design process.

The plugin runs entirely inside Figma. It has no network access, no analytics and no runtime dependencies.

## Install locally

You need [Node.js](https://nodejs.org/) 18 or newer and the Figma desktop app.

```sh
git clone https://github.com/Smilesharks/frz-1.git
cd frz-1
npm install
npm run build
```

Then in Figma desktop:

1. Open any design file.
2. Go to **Plugins > Development > Import plugin from manifest...**
3. Pick `manifest.json` in the `frz-1` folder.

The plugin now appears under **Plugins > Development > FRZ-1**. Run `npm run build` again after changing the code; Figma picks up the new `dist/code.js` the next time you open the plugin.

## Use it

1. Select one or more frames, or an instance. The window shows the selection name straight away. The instance readout shows `--` until you ask for a count.
2. Optional: press **Count** to see how many instances the selection contains, counting nested ones, and how deep the nesting goes. On a large frame this can take a second or two, which is why it only runs when you ask.
3. Leave **Rename copy** on to add `/ frozen YYYY-MM-DD HH:MM` to the copy's name, or press it to keep the original name.
4. Optional: turn on **Remove hidden** to delete every hidden layer from the copy once its instances are detached. It is off by default. Only layers with their visibility turned off count as hidden; layers at 0% opacity stay. The original keeps its hidden layers.
5. Press **Freeze**. The plugin duplicates the selection, places the copy to the right of it without overlapping other layers, and detaches every instance in the copy. If the selection turns out to have no instances, the copy is removed again and the window says so.
6. The report shows how many instances were detached, the nesting depth reached, how many instances are left (should be zero), how many hidden layers were removed (if you turned that on) and any layers that were skipped, with the reason.
7. Move the frozen copy wherever you keep your process frames.

The original is never changed. One **Undo** (Cmd+Z) removes the whole freeze.

![The plugin window after a run with Remove hidden on: 148 instances detached over 3 levels, 0 left, 12 hidden layers removed](docs/ui-result.png)

## How nested instances are handled

Detaching an instance turns it into a frame, but instances nested inside it stay linked to their own components. Figma also cannot detach an instance that sits inside another instance without detaching its parents first.

So the plugin works from the outside in, one level at a time:

1. Search the copy once with `findAllWithCriteria({ types: ['INSTANCE'] })` and keep the outermost instances, those with no instance above them.
2. Detach that level. Each detach returns a plain frame.
3. Search only inside those returned frames for the next level, then repeat until a level comes back empty.

The rest of the copy is never searched again, and the report is built from counters kept during the run, so there is no final scan. Progress goes to the window every 50 instances or every 200 ms, whichever comes first, with a short pause each time so Figma stays responsive.

The number of levels is the nesting depth shown in the report. Hidden instances are detached too, because a hidden instance is still a link to a component. With **Remove hidden** on, hidden layers are deleted after all levels are detached, because Figma does not allow deleting a layer inside a linked instance.

Most of the time on a large frame is Figma's own work. In a test with 2,000 instances nested 4 levels deep, detaching took about 11 seconds, and Figma needed about as long again to prepare the newly detached layers the first time the plugin read them. The plugin cannot avoid either cost; what it does is keep the progress bar moving while they happen.

## Limitations

- **Main components are skipped.** Selecting a main component would create a new component, not a snapshot, so the plugin skips it and says so in the report. A main component *inside* a selected frame is turned into a plain frame in the copy, so the snapshot adds nothing to your assets.
- **Component sets inside a frame stay as component sets.** Turning variants into frames would break the set, so the copy keeps a new component set and the report lists it.
- **Variables and styles stay linked.** Detaching removes the link to components only. Colours, text styles and variables used in the copy still point to your library, so changing a style or variable will change the frozen copy as well.
- **Very large frames** take a while. The plugin works in batches so Figma does not freeze, but thousands of instances still take seconds rather than milliseconds.

## Replace the screenshot

The images in `docs/` are rendered from `ui.html` with mock data by `npm run render` (it uses Playwright, installed as a development dependency only). To use a real screenshot instead:

1. Run the plugin in Figma desktop on a real frame.
2. Take a screenshot of the plugin window, for example with Cmd+Shift+4 then Space on macOS.
3. Save it as `docs/ui-result.png`, replacing the rendered one. For the cover, save a 1920 x 1080 image as `docs/cover.png`.

Running `npm run render` again will overwrite your screenshots, so only run it if you want the mock versions back.

## Project layout

```text
manifest.json      Figma plugin manifest (no network access, dynamic page loading)
src/code.ts        Plugin entry: talks to the UI and runs a freeze
src/freeze.ts      Duplicating, placing and detaching
ui.html            Plugin window: plain HTML, CSS and JavaScript
assets/            Icon as SVG and 128 x 128 PNG
docs/              README images
scripts/           Renders the icon PNG and README images
```

## Licence

[MIT](LICENSE)
