/**
 * The Windows UI Automation worker: the program that reads and drives a window.
 *
 * Windows exposes every window as a tree of automation elements (name, control
 * type, automation id, state, bounding box, and the actions an element supports:
 * invoke, set value, toggle, select). This is the same interface screen readers
 * use, and it is what lets a desktop application be observed from outside with
 * no hooks and no source: the tree is the structure a person perceives.
 *
 * The worker is a long-running PowerShell (Windows PowerShell 5.1, which ships
 * with every Windows) answering JSON lines, so one process serves a whole
 * exploration instead of paying PowerShell's start-up for every click. Ops:
 * `tree` (the outline, the controls with selectors, the layout boxes), `click`,
 * `fill`, `press` (keys, through SendKeys to the focused window), `shot` (a PNG
 * of the window), `alive`.
 *
 * Real applications are uneven, and the worker is written for that:
 *  - Modern controls expose actions (invoke, value, toggle, select) and are
 *    driven through them.
 *  - Older ones (WinForms and Win32 built on legacy accessibility) arrive as
 *    plain panes with NO actions, an AutomationId that is only the window
 *    handle (different on every run, so never used to find anything), and a
 *    window class such as `...EDIT...` or `...BUTTON...`. Those are recognised
 *    by class, clicked with a real mouse click at the element's centre, and
 *    typed into with keystrokes: what any automation client falls back to.
 *
 * Elements are addressed by selector text, `id:<AutomationId>` (when it is a
 * real id), `name:<Name>|type:<ControlType>`, or `path:<i.j.k>` (the position in
 * the tree), which is what the explorer records and the twin-test replays.
 *
 * Windows only. macOS (AXUIElement) and Linux (AT-SPI) need their own workers;
 * they are not built (ADR 0041). The script avoids the backtick so it can sit in
 * one `String.raw`; it is written out whole, never patched by search-and-replace
 * (a dollar-quote in PowerShell is a replacement token to JavaScript).
 *
 * @module cleanroom/desktop-worker
 */

export const DESKTOP_WORKER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class CleanroomW32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$procId = [int]$args[0]
$wantTitle = $args[1]
$script:win = $null
$script:count = 0
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Send-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Depth 30 -Compress)); [Console]::Out.Flush() }

function Find-Window($ms) {
  $end = [DateTime]::Now.AddMilliseconds($ms)
  while ([DateTime]::Now -lt $end) {
    if ($wantTitle) {
      $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $wantTitle)
    } else {
      $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $procId)
    }
    $w = $AE::RootElement.FindFirst($TS::Children, $cond)
    if ($w -ne $null) { return $w }
    Start-Sleep -Milliseconds 100
  }
  return $null
}

function Role-Of($el) { return ($el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') }

function Selector-Of($el, $path) {
  $id = $el.Current.AutomationId
  # A purely numeric id is a window handle: it differs on every run, so it cannot find the element again.
  if ($id -and $id -notmatch '^\d{5,}$') { return 'id:' + $id }
  $n = $el.Current.Name
  $r = Role-Of $el
  if ($n) { return 'name:' + $n + '|type:' + $r }
  return 'path:' + $path
}

function Find-Element($sel) {
  if ($sel.StartsWith('path:')) {
    $el = $script:win
    foreach ($ix in ($sel.Substring(5) -split '\.')) {
      if ($ix -eq '') { continue }
      $c = $walker.GetFirstChild($el)
      for ($k = 0; $k -lt [int]$ix -and $c -ne $null; $k++) { $c = $walker.GetNextSibling($c) }
      if ($c -eq $null) { return $null }
      $el = $c
    }
    return $el
  }
  $id = $null; $name = $null
  foreach ($p in ($sel -split '\|')) {
    if ($p.StartsWith('id:')) { $id = $p.Substring(3) }
    elseif ($p.StartsWith('name:')) { $name = $p.Substring(5) }
  }
  if ($id) { $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id) }
  elseif ($name) { $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name) }
  else { return $null }
  return $script:win.FindFirst($TS::Descendants, $cond)
}

$roleMap = @{ Button='button'; CheckBox='checkbox'; RadioButton='radio'; ComboBox='combobox'; Edit='textbox'; Hyperlink='link'; MenuItem='menuitem'; TabItem='tab'; ListItem='listitem'; Slider='slider'; Spinner='spinbutton'; SplitButton='button' }

function Kind-Of($el, $role, $name) {
  if ($role -eq 'Window') { return $null }
  if ($roleMap.ContainsKey($role)) { return $roleMap[$role] }
  # What an element can DO says more than what its control type is called.
  $o = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) { if (-not $o.Current.IsReadOnly) { return 'textbox' } }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { return 'button' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$o)) { return 'checkbox' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o)) { return 'listitem' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) { return 'combobox' }
  # Older apps (WinForms, Win32) expose plain panes with no actions at all, but the window class says what the control is.
  $cls = [string]$el.Current.ClassName
  if ($cls -match '(?i)(^|[._])(rich)?edit') { return 'textbox' }
  if ($cls -match '(?i)(^|[._])button') { return 'button' }
  if ($cls -match '(?i)(^|[._])combobox') { return 'combobox' }
  if ($cls -match '(?i)(^|[._])(listbox|syslistview|systreeview)') { return 'listitem' }
  if ($cls -match '(?i)(^|[._])systabcontrol') { return 'tab' }
  if ($el.Current.IsKeyboardFocusable) { if ($name) { return 'button' } else { return 'textbox' } }
  return $null
}

function Visit($el, $depth, $lines, $controls, $layout, $texts, $path) {
  if ($script:count -ge 400 -or $depth -gt 8) { return }
  $script:count++
  try {
    $role = Role-Of $el
    $name = $el.Current.Name
    $value = $null
    $o = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) { $value = $o.Current.Value }
    $line = (' ' * ($depth * 2)) + $role
    if ($name) { $line += ' "' + $name + '"' }
    if ($value) { $line += ' = "' + $value + '"' }
    if (-not $el.Current.IsEnabled) { $line += ' (disabled)' }
    [void]$lines.Add($line)
    if ($name -and $role -ne 'Window') { [void]$texts.Add($name) }
    if ($value) { [void]$texts.Add([string]$value) }
    $kind = Kind-Of $el $role $name
    if ($kind -and -not $el.Current.IsOffscreen) {
      $inputType = $null
      if ($kind -eq 'textbox') { $inputType = 'text' }
      [void]$controls.Add(@{ role = $kind; name = $name; selector = (Selector-Of $el $path); inputType = $inputType; formAction = '' })
    }
    $r = $el.Current.BoundingRectangle
    if ($depth -le 2 -and $r.Width -gt 40 -and $r.Height -gt 12 -and -not [double]::IsInfinity($r.X)) {
      [void]$layout.Add(@{ role = $role.ToLower(); x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height })
    }
  } catch { return }
  $child = $walker.GetFirstChild($el)
  $i = 0
  while ($child -ne $null) {
    $childPath = [string]$i
    if ($path -ne '') { $childPath = $path + '.' + $i }
    Visit $child ($depth + 1) $lines $controls $layout $texts $childPath
    $child = $walker.GetNextSibling($child)
    $i++
  }
}

function Do-Tree() {
  $script:count = 0
  $lines = New-Object System.Collections.ArrayList
  $controls = New-Object System.Collections.ArrayList
  $layout = New-Object System.Collections.ArrayList
  $texts = New-Object System.Collections.ArrayList
  Visit $script:win 0 $lines $controls $layout $texts ''
  $r = $script:win.Current.BoundingRectangle
  return @{ ok = $true; title = $script:win.Current.Name; tree = ($lines -join [Environment]::NewLine); text = ($texts -join ' '); controls = $controls; layout = $layout; width = [int]$r.Width; height = [int]$r.Height }
}

function Focus-Window() {
  $h = [IntPtr]$script:win.Current.NativeWindowHandle
  if ($h -ne [IntPtr]::Zero) { [void][CleanroomW32]::ShowWindow($h, 9); [void][CleanroomW32]::SetForegroundWindow($h) }
  Start-Sleep -Milliseconds 120
}

function Do-Shot() {
  Focus-Window
  $r = $script:win.Current.BoundingRectangle
  $bmp = New-Object System.Drawing.Bitmap([int]$r.Width, [int]$r.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return @{ ok = $true; png = [Convert]::ToBase64String($ms.ToArray()) }
}

# The fallback an automation client uses when an element offers no action: click where it is.
function Physical-Click($el) {
  Focus-Window
  $r = $el.Current.BoundingRectangle
  $x = [int]($r.X + $r.Width / 2)
  $y = [int]($r.Y + $r.Height / 2)
  [void][CleanroomW32]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 60
  [CleanroomW32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [CleanroomW32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}

function Escape-Keys($t) { return [regex]::Replace($t, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' }) }

function Key-Seq($k) {
  $m = @{ Enter='{ENTER}'; Return='{ENTER}'; Tab='{TAB}'; Escape='{ESC}'; Esc='{ESC}'; Backspace='{BACKSPACE}'; Delete='{DELETE}'; ArrowUp='{UP}'; ArrowDown='{DOWN}'; ArrowLeft='{LEFT}'; ArrowRight='{RIGHT}'; Home='{HOME}'; End='{END}'; PageUp='{PGUP}'; PageDown='{PGDN}'; Space=' ' }
  if ($m.ContainsKey($k)) { return $m[$k] }
  if ($k -match '^(?i:ctrl)\+(.)$') { return '^' + $Matches[1].ToLower() }
  if ($k -match '^(?i:alt)\+(.)$') { return '%' + $Matches[1].ToLower() }
  if ($k -match '^F([1-9]|1[0-2])$') { return '{' + $k + '}' }
  return $k
}

$script:win = Find-Window 20000
if ($script:win -eq $null) { Send-Json @{ event = 'load-failed'; error = 'no window appeared for the application' }; exit 3 }
Send-Json @{ event = 'ready'; title = $script:win.Current.Name }

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if (-not $line.Trim()) { continue }
  $msg = $line | ConvertFrom-Json
  try {
    if ($msg.op -eq 'tree') { $out = Do-Tree }
    elseif ($msg.op -eq 'shot') { $out = Do-Shot }
    elseif ($msg.op -eq 'alive') { $out = @{ ok = $true; alive = ($AE::RootElement.FindFirst($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $procId))) -ne $null) } }
    elseif ($msg.op -eq 'click') {
      $el = Find-Element $msg.selector
      if ($el -eq $null) { $out = @{ ok = $false; error = 'no element matches ' + $msg.selector } }
      else {
        $o = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { $o.Invoke(); $out = @{ ok = $true } }
        elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$o)) { $o.Toggle(); $out = @{ ok = $true } }
        elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o)) { $o.Select(); $out = @{ ok = $true } }
        elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) { $o.Expand(); $out = @{ ok = $true } }
        else { Physical-Click $el; $out = @{ ok = $true; how = 'physical click' } }
      }
    }
    elseif ($msg.op -eq 'fill') {
      $el = Find-Element $msg.selector
      if ($el -eq $null) { $out = @{ ok = $false; error = 'no element matches ' + $msg.selector } }
      else {
        $o = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) { $o.SetValue([string]$msg.value); $out = @{ ok = $true } }
        else { Physical-Click $el; [System.Windows.Forms.SendKeys]::SendWait('^a'); [System.Windows.Forms.SendKeys]::SendWait((Escape-Keys ([string]$msg.value))); $out = @{ ok = $true; how = 'typed' } }
      }
    }
    elseif ($msg.op -eq 'press') {
      Focus-Window
      [System.Windows.Forms.SendKeys]::SendWait((Key-Seq $msg.key))
      $out = @{ ok = $true }
    }
    else { $out = @{ ok = $false; error = 'unknown op ' + $msg.op } }
  } catch { $out = @{ ok = $false; error = $_.Exception.Message } }
  $out['id'] = $msg.id
  Send-Json $out
}
`;
