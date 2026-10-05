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
| `fork/nh-fork.js` | Server-side (njs) readaloud index |

Upstream files carry only small hooks: one `sub_filter` and one `include` at the end of
`default.conf.template`, three `COPY` lines in the `Dockerfile`, and small changes in
`theme/enhancements.js` (marked `hobesman fork`): three one-line hooks (two for the Readaloud
filter, one for search) and two performance fixes (see Performance).

## Performance

Big libraries loaded slowly through the theme (seconds, versus under one directly in ABS):

- **Series badge data** (series completion badges): the theme asked ABS for every series with
  all its books on each full page load. That takes ABS seconds on a big library, and ABS
  answers one request at a time, so the page's own startup requests waited behind it. It is
  now kept in the browser (series and book ids only, about 1/20 of the size), refreshed in the
  background at most every 6 hours once the page is showing, and fetched the first time only
  after the page is showing (`theme/custom.js`).
- Two per-update layout reads in `enhancements.js` (the edit window's Goodreads line, the shelf
  centring) forced the browser to lay out the whole page on every theme update while a big
  shelf was built; both now skip that work.
- **Timing report** for troubleshooting: add `?nhtiming=1` to any NanoHive address (remembered;
  `?nhtiming=0` turns it off), reload, and read the `[NanoHive timing]` lines in the browser
  console (`copy(__nhTiming)` copies them).

## Features

### Readaloud badge

On a book's page, a speaker icon sits on the corner of the **Read** button when the book has an
ebook file with "readaloud" in its filename. Clicking it opens the read-along reader (below).

### Search: similar matches

ABS's library search only finds the typed text as one exact string. When the search bar finds
fewer than 5 books, it also looks for close matches and lists them under **Similar matches**:
words in any order, a missing or extra word, small typos (one or two letters off), in titles,
authors, series and narrators. A matching series also brings its books, and a matching narrator
the books they read; the reason is shown under the author ("read by …", or the series name). It asks ABS about each significant word separately (and the first letters
of long words, to catch typos later in the word), then ranks the results by how many of the
typed words they match. That is a handful of extra small searches, only when the exact search
came up short.

**Apps too.** Searches from apps (or ABS's own web UI) that go through NanoHive are handled on the
server (`fork/nh-fork.js`): a search ABS finds **nothing** for is answered with similar matches
instead, in ABS's own format with full book records, so apps show them as ordinary results (the
reply carries an `X-NH-Similar: 1` header). Any search with even one exact result is passed
through untouched, so exact results are never delayed. Apps that talk to ABS directly, not
through NanoHive, are not affected. The theme's search bar marks its own searches
(`X-NH-No-Fuzzy`) so the server leaves them alone.

### Readaloud filter

**Filter & sort → Format → Readaloud** shows only books with a readaloud ebook. ABS's library
list doesn't include file names, so which books have one is kept in a small shared index on the
server (`/data/nh/readaloud.json`, keep the `/data/nh` volume):

- When the panel downloads a library's book list, books the index doesn't know yet, or that ABS
  says changed since (`updatedAt` / file count), are checked: 20 at a time, by the NanoHive
  container asking ABS (`/api/items/batch/get` with the user's own token). Browsers only say
  which books to check, never what the answer is.
- First build for 2,000 books in testing: about 30 s in the background, ABS averaging ~20% of
  one core; after that only changed books are re-checked.

### Read-along reader

Click the speaker icon on a readaloud book's **Read** button to open a full-screen reader that
plays the book's narration and highlights each sentence as it is read, turning pages to follow
(EPUB 3 Media Overlays, as made by [Storyteller](https://gitlab.com/storyteller-platform/storyteller)).

- Play/pause (Space), previous/next sentence (↑/↓), page turns (←/→ or the page edges), speed
  (presets from 0.75× to 5×, or any speed from 0.5× to 5× in 0.05 steps),
  contents, theme (dark/sepia/light) and text size. Tap a sentence to read from there.
- Lock-screen / headphone controls through the browser's Media Session API.
- The EPUB is read from ABS with HTTP range requests: only the parts being read or played are
  downloaded, never the whole file.
- Progress goes to Audiobookshelf, not Storyteller:
  - the **audiobook position** (`currentTime`), mapped from the EPUB's audio onto the ABS
    audiobook's timeline, so the ABS apps resume listening at the same sentence;
  - the **ebook position** (`ebookLocation` + `ebookProgress`), so ABS's own **Read** button opens
    at the same page. When the book's primary ebook is the regular EPUB (not the readaloud), the
    position is translated by finding the text at the top of the page in the same chapter of that
    EPUB (Storyteller rewrites the XHTML, so locations can't be copied across); the same works in
    reverse when you have been reading in ABS's reader;
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
