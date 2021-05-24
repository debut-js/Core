export function logDebug(...data: any[]) {
    console.log(new Date().toLocaleString(), ...data);
}
