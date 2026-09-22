# Import your Telegram writing

Wordmanner reads a Telegram Desktop `result.json` **on your machine**. The preview and prepared examples stay under `~/.wordmanner/imports/` unless you choose another directory. No connector, account token, or Wordmanner server is involved. When an AI agent later uses selected examples through `wordmanner context`, those excerpts may be sent to that agent's model provider.

Telegram Desktop can export one chat or multiple chats through its [export controls](https://t.me/s/TelegramTips/91). The current Wordmanner importer accepts the full-account JSON export with `chats.list` and Saved Messages; support for a single-chat JSON export is planned. Choose JSON when exporting and pass the path to its `result.json`:

```sh
wordmanner telegram preview "/path/to/result.json"
```

The command prints a private `report.md` path. It identifies your sender ID from Saved Messages and lists chat IDs, names, last sent dates, and counts of possible Russian and English examples. It stores no message text in this preview. Pick a few chats with the register you want to teach, and keep work, friends, and groups in separate passes.

```sh
wordmanner telegram prepare ~/.wordmanner/imports/telegram-preview-... \
  --chats 123456,789012 --language ru --audience friend
```

The command prints a new private `review.md` path. It chooses up to 80 short, user-authored messages, balanced across chosen chats. It skips Saved Messages, other people's text, forwards, media captions, links, detected contact details, very short reactions, and texts over 240 characters. Language detection is conservative: Latin-script messages without enough English evidence are left out. The filters are **not a guarantee that private details are absent**; review the prepared text before importing it.

To exclude examples by their numbers in `review.md`:

```sh
wordmanner telegram exclude ~/.wordmanner/imports/telegram-review-... --numbers 1,3,8
wordmanner telegram apply ~/.wordmanner/imports/telegram-review-...
```

You can also edit `samples.jsonl` in the review directory before `apply`. Each line is one example. `apply` is the first step that changes your Wordmanner sample library. If a message was already imported from a previous export, duplicate IDs stop the import instead of silently adding it again.

The importer streams the JSON rather than loading the archive at once. It never reads the exported media files. The source export remains wherever Telegram wrote it. Treat that original export as sensitive: it contains other people's messages too.
