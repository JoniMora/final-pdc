param([ValidateSet('preparar','levantar','migrar','estado','pruebas','detener')][string]$Accion='estado')
& node (Join-Path $PSScriptRoot 'entrega5.js') $Accion
if ($LASTEXITCODE -ne 0) { throw 'No se completó la acción de entrega 5' }
