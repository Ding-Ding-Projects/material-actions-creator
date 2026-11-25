# Language, sound and personal wording

## Language

Choose **English**, **Cantonese** or **Bilingual** in Settings. Bilingual shows English with a compact Cantonese line under each label. Two funny-level sliders (1 = serious, 5 = playful) change the tone of each language separately. School mode keeps every message at the most serious level.

## Personal wording

Upload a vocabulary JSON file in **Settings → Personal wording**, or drop it anywhere on the window:

```json
{
  "schemaVersion": 1,
  "name": "My words",
  "entries": {
    "the workflow run failed": "my build broke",
    "repository": "project"
  }
}
```

Entries replace whole phrases everywhere in the app, including messages from the server such as failure text. Longer phrases win over shorter ones, and capitalisation is kept. The file stays in this browser only: it is never uploaded, logged, exported or recorded in settings history. **Remove** clears it.

## Sound and narration

Action sounds can be switched off or turned down. Narration reads notifications aloud with the voice and speed you choose.
