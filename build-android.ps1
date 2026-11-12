# Build Folia for Android (Capacitor) - one-shot script.
# Usage:
#   1) Install Android Studio (or Android SDK cmdline-tools), JDK 17+.
#   2) Make sure Gradle can find the SDK: set ANDROID_HOME, or create
#      android/local.properties containing: sdk.dir=<your SDK path>
#   3) Open PowerShell at the project root and run:  .\build-android.ps1
#
# Notes: comments kept ASCII on purpose so PowerShell 5.1 does not garble them.

$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'node_modules')) {
    Write-Host '[0/4] Installing npm dependencies ...'
    npm install
}

if (-not $env:ANDROID_HOME -and -not (Test-Path 'android\local.properties')) {
    Write-Warning 'No ANDROID_HOME and no android\local.properties found. Gradle may fail to locate the Android SDK.'
}

Write-Host '[1/4] Building Capacitor web bundle ...'
$env:CAPACITOR = 'true'
try {
    npx vite build
} finally {
    Remove-Item Env:\CAPACITOR -ErrorAction SilentlyContinue
}

Write-Host '[2/4] Syncing web assets and plugins into the native project ...'
npx cap sync android

Write-Host '[3/4] Building debug APK ...'
Push-Location android
try {
    .\gradlew.bat assembleDebug
} finally {
    Pop-Location
}

Write-Host '[4/4] Done. APK:'
Write-Host '  android\app\build\outputs\apk\debug\app-debug.apk'
Write-Host 'Install with:  adb install -r android\app\build\outputs\apk\debug\app-debug.apk'
