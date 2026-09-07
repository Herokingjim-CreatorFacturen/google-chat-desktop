; --- INNO SETUP CONFIGURATION FOR GOOGLE CHAT (BAREBONES) ---

#define MyAppName "Google Chat"
#define MyAppVersion "1.3.4"
#define MyAppPublisher "Jimmy de Heus"
; IMPORTANT: Verify this exactly matches the .exe name inside dist\win-unpacked!
#define MyAppExeName "Google Chat.exe"
#define MyAppID "com.yourname.googlechat"

[Setup]
AppId={{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Installs to C:\Program Files\Google Chat
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; MUST BE 'admin' when installing to {autopf} (Program Files)
PrivilegesRequired=admin
OutputDir=dist
OutputBaseFilename=GoogleChatSetup_Eddie_1.3.4
SetupIconFile=icon.ico
Compression=lzma
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Grabs the clean, freshly built app
Source: "dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; FORCES the icon to be copied into the installation folder so the shortcut can see it
Source: "icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; CRITICAL: AppUserModelID allows native Windows notifications. IconFilename forces the logo to show.
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icon.ico"; AppUserModelID: "{#MyAppID}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; IconFilename: "{app}\icon.ico"; AppUserModelID: "{#MyAppID}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent