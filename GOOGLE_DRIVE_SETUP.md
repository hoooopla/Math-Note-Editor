# Google Drive workspaces

The web app can let each user sign in with their own Google account and choose a Drive folder containing Math Note Markdown files.

## Google Cloud setup

1. Create or select a Google Cloud project.
2. Enable **Google Drive API** and **Google Picker API**.
3. Configure the OAuth consent screen and add the Drive scope (`https://www.googleapis.com/auth/drive`). Public use of this broad scope normally requires Google verification.
4. Create an **OAuth 2.0 Client ID** for a Web application. Add every deployed origin and the local development origin (for example `http://localhost:3000`) to **Authorized JavaScript origins**.
5. Create a browser API key for Google Picker. Restrict it to your deployed origins and to the Google Picker API.
6. Copy `.env.example` to `.env.local` and provide the OAuth client ID, browser API key, and numeric Cloud project number.

Restart the web server after changing environment variables.

## Security and behavior

- Access tokens are kept in browser memory, not local storage, and are revoked on disconnect.
- The user explicitly chooses a folder through Google Picker.
- The app requests full Drive access because Google’s narrower `drive.file` scope cannot enumerate and edit arbitrary existing Markdown files in a selected folder.
- Before overwriting a file, the app compares its Drive version and stops if another user or device changed it.
- Tokens are short-lived. If one expires, the user is asked to reconnect.
- Image attachments and workspace backups are not yet available in Google Drive mode.
