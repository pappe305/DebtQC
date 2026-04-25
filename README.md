# Call QA Reviewer

A local Windows-friendly app for reviewing call recordings against intake notes, approved scripts, and internal process rules.

## What it does

- Uploads a call recording from your PC.
- Transcribes the recording with OpenAI speech-to-text.
- Compares the transcript to the intake captured during the call.
- Flags intake errors, missing information, off-script moments, process violations, and coaching notes.
- Saves your standard script and process rules in the app so you do not need to reload them for every call.
- Saves each review as JSON in `data/reports`.

## Supported files

- Call recordings: MP3, WAV, M4A, OGG, MP4, WebM, and most browser-selectable audio/video files.
- Intake, script, and process files: TXT, CSV, JSON, MD, DOCX, XLSX, PDF, JPG, PNG, WEBP, and GIF.
- Not supported yet: old Word `.doc` and old Excel `.xls` files. Open those in Word or Excel and save as DOCX/XLSX or CSV first.

## Setup

1. Set your OpenAI API key in PowerShell:

   ```powershell
   setx OPENAI_API_KEY "your_api_key_here"
   ```

2. Close and reopen PowerShell so Windows reloads the key.

3. Start the app:

   ```powershell
   .\start-windows.bat
   ```

4. Open `http://localhost:4377` in your browser.

## Optional settings

You can change models before starting the app:

```powershell
$env:OPENAI_TRANSCRIPTION_MODEL="gpt-4o-transcribe-diarize"
$env:OPENAI_QA_MODEL="gpt-4.1"
$env:MAX_UPLOAD_MB="200"
.\start-windows.bat
```

## Privacy notes

Recordings are stored locally under `data/uploads`, saved script/process defaults are stored in `data/defaults.json`, and reports are stored under `data/reports`. The audio and review materials are sent to OpenAI for transcription and analysis when you run a review.

## Best results

Paste the actual intake notes or CRM export into the intake field. Add your approved script and internal processes, including required disclosures, verification steps, escalation rules, and any phrases agents must avoid.
