const Bluez = require('..');
const child_process = require("child_process");
const { promisify } = require('util');

const exec = promisify(child_process.exec);

function delay(ms) {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, ms);
    });
}

const bluetooth = new Bluez();
let adapter;

// Register callback for new devices
bluetooth.on('device', (address, props) => {
    // apply some filtering
    console.log(`Found device named ${props.Name} at ${address}`);
    if (props.Name !== "Muse-303A") return;
    handleDevice(address, props).catch(console.error);
});

bluetooth.init().then(async () => {
    // listen on first bluetooth adapter
    adapter = await bluetooth.getAdapter('hci0');
    await adapter.StartDiscovery();
    console.log("Discovering");
});

process.on("SIGINT", () => {
    bluetooth.bus.disconnect();
    process.removeAllListeners("SIGINT");
});


async function handleDevice(address, props) {
    console.log("Using " + address, props);

    // Get the device interface
    const device = await bluetooth.getDevice(address);

    device.on('servicesResolved', (b) => {
        if (b) console.log('Services are resolved!!!');
    });

    device.on('connected', (b) => {
        console.log(`Device is connected ${b}`);
    });


    if (!props.Connected) {
        console.log("Connecting to ", address);        
        await device.Connect();        
    }

    if (!await device.ServicesResolved()) {
        console.log("Services not resolved yet");
    }

    // wait until services are resolved
    for (let i = 0; !await device.ServicesResolved(); i++) {
        if (i > 100) {
            const props = await device.getProperties();
            throw new Error("No Services Resolved");
        }
        await delay(100);
    }
    await delay(10);

    // get the Service
    const service = device.getService("0000ffe0-0000-1000-8000-00805f9b34fb");
    if (!service) return console.log("No Service");
    // get the Characteristic from the Service
    const characteristic = service.getCharacteristic("0000ffe1-0000-1000-8000-00805f9b34fb");
    if (!characteristic) return console.log("No Characteristic");

    // on old Bluez versions < 5.48 AcquireNotify and AcquireWrite are not available
    // if thats the case use handleComOld
    await handleCom(device, characteristic);
    //await handleComOld(device, characteristic);

    if (adapter)
        await adapter.StopDiscovery().catch(() => { });
}