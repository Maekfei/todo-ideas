# 💡 Flow Board

A Notion-style flow board for capturing ideas and shipping todos.
Live: https://maekfei.github.io/todo-ideas/

## ✨ Features

### Visual
- Notion-inspired clean light & dark theme (auto-detects system)
- Subtle column tints (yellow/blue/green) + gradient brand line
- Priority color bars on cards (high/mid/low)
- Animated drag placeholder line (clear drop indicator)
- Empty-state illustrations per column
- Custom scrollbars, refined typography (Inter + system fallbacks)
- Fully responsive (mobile, tablet, desktop)

### Functional
- 💡 Ideas → ✅ Todos → 🎉 Done flow with drag & drop
- ✏️ Inline edit (double-click any card) with **markdown** notes
- 🔁 Repeating tasks (daily / weekly / monthly auto-spawn on completion)
- 🏷️ Custom tags with emoji
- ⭐ Priority + due date with overdue/today badges
- 🎯 "Today Focus" hero showing overdue + today + high-priority items
- 👋 Time-of-day greeting + daily completion counter
- 🔍 Real-time search + filter by tag / priority
- ↶ Undo (Cmd/Ctrl+Z, plus 5s undo toast on delete)
- ⌨️ Keyboard shortcuts (press `?` to view all)
- 📊 Stats: completion rate + 14-day activity heatmap
- 🌙 Dark / light theme toggle (T key)
- ☁️ Optional GitHub Issues sync (multi-device, auto-merge by timestamp)
- 📥 / 📤 Import & export JSON
- 🧹 Auto-clean old Done items (>7 days)
- 📱 PWA installable + offline-capable (service worker)

## 🎹 Keyboard Shortcuts

| Key | Action |
|---|---|
| `N` | Focus quick add |
| `/` | Focus search |
| `Enter` | Add as 💡 idea |
| `Shift+Enter` | Add as ✅ todo |
| `?` | Show shortcuts |
| `Esc` | Close modal |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Enter` | Save edit modal |
| `T` | Toggle theme |
| `S` | Sync to GitHub |

## ☁️ GitHub Sync (optional)

1. Create a Personal Access Token with `repo` scope at https://github.com/settings/tokens
2. Open ⚙️ Settings → paste token + repo (e.g. `Maekfei/todo-ideas`)
3. Tick "auto sync" — it will pull on load and push 30s after each change
4. Use the same token on another device for multi-device sync
5. **Recommended**: use a private repo for personal data

## 🛠️ Stack

- Pure HTML / CSS / JS — no build step, no framework
- LocalStorage for persistence (data survives reloads)
- GitHub Issues API for optional sync
- Service Worker for offline / PWA install
- Hosted on GitHub Pages

## 📄 License

MIT
