# hobesman fork of NanoHive

This fork tracks [rodzalendo/nanohive-abs-theme](https://github.com/rodzalendo/nanohive-abs-theme)
and adds a few features of its own. Image: `ghcr.io/hobesman/nanohive-abs-theme:latest`.

## Staying in sync with upstream

`.github/workflows/sync-upstream.yml` merges upstream's `main` every day (or on demand from the
Actions tab). A clean merge that passes the checks is pushed and the image rebuilt. A conflict or
failure pushes nothing and opens an `upstream-sync` issue instead; the next good sync closes it.

To keep merges clean, the fork's code lives in its own files:

| File | What |
|---|---|
| `theme/custom.js` | All fork UI (injected after the upstream theme scripts) |
| `theme/reader/` | Read-along reader (ES modules, loaded on demand) and its foliate-js copy |
| `fork/nh-fork.locations.template` | Extra nginx locations |
| `fork/07-nh-fork.envsh` | Defaults and checks for the fork's env vars |

Upstream files carry only small hooks: one `sub_filter` and one `include` at the end of
`default.conf.template`, and two `COPY` lines in the `Dockerfile`.

## Features

### Readaloud badge

On a book's page, a speaker icon sits on the corner of the **Read** button when the book has an
ebook file with "readaloud" in its filename. Clicking it opens the read-along reader (below).

### Read-along reader

Click the speaker icon on a readaloud book's **Read** button to open a full-screen reader that
plays the book's narration and highlights each sentence as it is read, turning pages to follow
(EPUB 3 Media Overlays, as made by [Storyteller](https://gitlab.com/storyteller-platform/storyteller)).

- Play/pause (Space), previous/next sentence (↑/↓), page turns (←/→ or the page edges), speed
  (presets from 0.75× to 3×, or any speed from 0.5× to 3× in 0.05 steps),
  contents, theme (dark/sepia/light) and text size. Tap a sentence to read from there.
- Lock-screen / headphone controls through the browser's Media Session API.
- The EPUB is read from ABS with HTTP range requests: only the parts being read or played are
  downloaded, never the whole file.
- Progress goes to Audiobookshelf, not Storyteller:
  - the **audiobook position** (`currentTime`), mapped from the EPUB's audio onto the ABS
    audiobook's timeline, so the ABS apps resume listening at the same sentence;
  - the **ebook position** (`ebookProgress`, and `ebookLocation` when the readaloud is the book's
    primary ebook; otherwise ABS's reader is opening a different file whose locations differ);
  - a real **listening session** (device "NanoHive Read-Along") while audio plays, so listening
    stats count.
- On open it resumes from whichever position moved last: listening in the ABS app or reading in
  ABS's own reader is picked up.
- Opening it stops anything else playing in that browser window first. ABS's own player is
  closed properly (position saved, session ended), so the reader carries on from where it stopped.

Code: `theme/reader/readalong.js` (loaded on first use) and `theme/reader/foliate/`, an unmodified
copy of [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) at commit `78914ae`, used for
rendering.

### Request a book (ReadMeABook)

A **Request a book** button next to the search box opens a search of
[ReadMeABook](https://github.com/kikootwo/readmeabook). Pressing **Request** on a result first
searches your ABS libraries for similar books (fuzzy title and author match) and lists them, so
you can check you don't already have it. Confirming sends the request to RMAB. If RMAB is set up
to download ebooks, it adds the ebook on its own once the audiobook is in.

Set these on the theme container:

```yaml
    environment:
      NH_RMAB_URL: "http://readmeabook:3030"   # RMAB's address from inside this container, no trailing slash
      NH_RMAB_TOKEN: "rmab_..."                # RMAB -> Settings -> API tokens
```

The theme container must be able to reach RMAB at that address (for example the same Docker
network, using RMAB's service name). The token stays on the server; the browser only talks to
`/_nh/rmab/*`, which needs a signed-in ABS user and can only search and create requests. All
requests appear in RMAB under the token's user, and that user's approval settings apply. Without
`NH_RMAB_URL` the button doesn't appear.
