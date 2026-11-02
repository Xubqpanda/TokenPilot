# Claw-Eval task fixtures

This directory keeps the task definitions and graders in Git:

- `task.yaml`
- `grader.py`

Large task-local fixture payloads are stored outside Git:

- `fixtures/` media files
- task-local PDFs and OCR inputs
- task-local JSON fixture bundles
- generated `output.html` reference files

## Expected restore layout

After download, restore the full task tree under:

```text
benchmarks/claw-eval/dataset/tasks/
```

Uploading the whole `tasks/` directory is recommended in practice. It avoids
manual per-task fixture selection and makes fresh-machine restore simpler.
