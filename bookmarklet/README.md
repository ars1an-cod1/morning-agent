# Deadline sync bookmarklet

RTU e-studijas has no calendar export and login needs Microsoft Authenticator,
so the bot cannot log in by itself. Instead, a bookmark you click on e-studijas
reads your not-yet-submitted deadlines (the same list as the dashboard's "Timeline")
with your open session and saves them to the `DEADLINES_JSON` repository variable
(Settings → Secrets and variables → Actions → Variables). Variables appear in plain text in the
Actions logs (public in a public repo), so the list is locked with a password first (AES-GCM).
The bot unlocks it with the same password, stored as the `DEADLINES_KEY` secret.

Click it every week or two (teachers usually post assignments early). If the file is older
than 14 days, the morning message reminds you.

## Setup (once)

1. **GitHub token**: github.com/settings/personal-access-tokens/new →
   name `mimoza-deadlines`, only repository `morning-agent`, permission **Variables: Read and write**.
2. **Password**: make up a long password and add it as the `DEADLINES_KEY` repository secret.
3. **Bookmark**: in Edge press Ctrl+D on any page → More → Name `Mimoza sync` →
   URL: paste the whole content of [`bookmarklet.txt`](bookmarklet.txt) → Save to Favorites bar.
4. Open estudijas.rtu.lv (logged in), click the bookmark, paste the token and type the password when asked.
   Both are remembered in this browser, so next time it is just one click.

## Files

| File | What it is |
|---|---|
| `sync.js` | Readable source of the bookmarklet |
| `bookmarklet.txt` | The same code as one line, ready to paste as the bookmark URL |

After changing `sync.js`, rebuild `bookmarklet.txt`:

```bash
node -e "const s=require('fs').readFileSync('bookmarklet/sync.js','utf8').split('\n').filter(l=>!l.trim().startsWith('//')).map(l=>l.trim()).join(' ');require('fs').writeFileSync('bookmarklet/bookmarklet.txt','javascript:'+s.replace(/%/g,'%25').replace(/#/g,'%23')+'\n')"
```
