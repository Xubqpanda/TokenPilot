$OutDir = "$HOME\Desktop\fws-discovery-cache"
$ZipPath = "$HOME\Desktop\fws-discovery-cache.zip"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Invoke-WebRequest "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest" -OutFile "$OutDir\gmail_v1.json"
Invoke-WebRequest "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest" -OutFile "$OutDir\calendar_v3.json"
Invoke-WebRequest "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest" -OutFile "$OutDir\drive_v3.json"
Invoke-WebRequest "https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest" -OutFile "$OutDir\tasks_v1.json"
Invoke-WebRequest "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest" -OutFile "$OutDir\sheets_v4.json"
Invoke-WebRequest "https://www.googleapis.com/discovery/v1/apis/people/v1/rest" -OutFile "$OutDir\people_v1.json"

Compress-Archive -Path "$OutDir\*" -DestinationPath $ZipPath -Force

Write-Host "Done: $ZipPath"
