# Claw-Eval task fixtures

This directory keeps the task definitions and graders in Git:

- `task.yaml`
- `grader.py`

Large task-local fixture payloads are stored outside Git:

- `fixtures/` media files
- task-local PDFs and OCR inputs
- task-local JSON fixture bundles
- generated `output.html` reference files

## Source of truth

Google Drive root:

- <https://drive.google.com/drive/u/0/folders/1AeMW693aMhyBKscUDbaxnrXfvE8aSBXg>

Recommended Drive path:

```text
LightMem2/TokenPilot/experiment-data/claw-eval/tasks/
```

## Expected restore layout

After download, restore the full task tree under:

```text
experiments/tokenpilot/claw-eval/dataset/tasks/
```

Uploading the whole `tasks/` directory is recommended in practice. It avoids
manual per-task fixture selection and makes fresh-machine restore simpler.
