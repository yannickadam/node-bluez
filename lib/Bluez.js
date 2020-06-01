const EventEmitter = require('events').EventEmitter;
const DBus = require('dbus');
const util = require('util');

const Adapter = require('./Adapter');
const Device = require('./Device');
const Agent = require('./Agent');
const Profile = require('./Profile');
const SerialProfile = require('./SerialProfile');

const Service = require('./Service');
const Characteristic = require('./Characteristic');
const Descriptor = require('./Descriptor');

class Bluez extends EventEmitter {
    constructor(options) {
        super();
        this.options = Object.assign({
            service: null, // connection local service
            objectPath: "/org/node/bluez"
        }, options);
        this.bus = this.options.bus || this.getUserService().bus;//DBus.getBus('system');
        if (this.options.service && typeof this.options.service !== "string")
            this.userService = this.options.service;

        this.getInterface = util.promisify(this.bus.getInterface.bind(this.bus));
        this.adapter = {};
        this.devices = {};

        this._path = {};
    }

    async init() {
        if(this.objectManager) this.objectManager.removeAllListeners();
        this.objectManager = await this.getInterface('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager');
        this.agentManager = await this.getInterface('org.bluez', '/org/bluez', 'org.bluez.AgentManager1');
        this.profileManager = await this.getInterface('org.bluez', '/org/bluez', 'org.bluez.ProfileManager1');

        this.objectManager.on('InterfacesAdded', this.onInterfacesAdded.bind(this));
        this.objectManager.on('InterfacesRemoved', this.onInterfaceRemoved.bind(this));
        this.objectManager.GetManagedObjects((err, objs) => {
            Object.keys(objs).forEach((k) => this.onInterfacesAdded(k, objs[k]))
        });
    }

    async getAdapter(dev) {
        const match = dev.match(new RegExp("^/org/bluez/(\\w+)$"));
        if (match) dev = match[1];
        // If the adapter was not discovered jet, try the default path.
        let path = '/org/bluez/' + dev;
        if (this.adapter[dev]) {
            if (typeof this.adapter[dev] === "string") {
                path = this.adapter[dev];
            } else {
                // Adapter already created
                return this.adapter[dev];
            }
        }
        const interface_ = await this.getInterface('org.bluez', path, 'org.bluez.Adapter1').catch((err) => {
            //TODO check err
            //console.log(err);
            return null;
        });
        if (!interface_) throw new Error("Adapter not found");
        this.adapter[dev] = new Adapter(interface_);
        return this.adapter[dev];
    }

    async getDevice(address) {            
        const original = address.replace(/:/g, "_"); 
        const match = address.match(new RegExp("^/org/bluez/(\\w+)/dev_(\\w+)$"));
        if (match) address = match[2];
        address = address.replace(/_/g, ":");
        if (this.devices[address] && typeof this.devices[address] !== 'string') {
            // Device already created
            return this.devices[address];
        }
        if (!this.devices[address]) throw new Error("Device not found");
        const interface_ = await this.getInterface('org.bluez', this.devices[address], 'org.bluez.Device1');
        
        const changed_ = await this.getInterface('org.bluez', `/org/bluez/hci0/dev_${original}`, 'org.freedesktop.DBus.Properties');
        // need to check here again, there might be a race because of await
        if (this.devices[address] && typeof this.devices[address] !== 'string') {
            // Device already created
            return this.devices[address];
        }
        this.devices[address] = new Device(interface_, changed_);
        return this.devices[address];
    }

    /*
    This registers a profile implementation.

    If an application disconnects from the bus all
    its registered profiles will be removed.

    HFP HS UUID: 0000111e-0000-1000-8000-00805f9b34fb

        Default RFCOMM channel is 6. And this requires
        authentication.

    Available options:

        string Name

            Human readable name for the profile

        string Service

            The primary service class UUID
            (if different from the actual
                profile UUID)

        string Role

            For asymmetric profiles that do not
            have UUIDs available to uniquely
            identify each side this
            parameter allows specifying the
            precise local role.

            Possible values: "client", "server"

        uint16 Channel

            RFCOMM channel number that is used
            for client and server UUIDs.

            If applicable it will be used in the
            SDP record as well.

        uint16 PSM

            PSM number that is used for client
            and server UUIDs.

            If applicable it will be used in the
            SDP record as well.

        boolean RequireAuthentication

            Pairing is required before connections
            will be established. No devices will
            be connected if not paired.

        boolean RequireAuthorization

            Request authorization before any
            connection will be established.

        boolean AutoConnect

            In case of a client UUID this will
            force connection of the RFCOMM or
            L2CAP channels when a remote device
            is connected.

        string ServiceRecord

            Provide a manual SDP record.

        uint16 Version

            Profile version (for SDP record)

        uint16 Features

            Profile features (for SDP record)

    Possible errors: org.bluez.Error.InvalidArguments
                        org.bluez.Error.AlreadyExists
    */
    registerProfile(profile, options) {
        // assert(profile instance of Profile)
        const self = this;
        return new Promise((resolve, reject) => {
            self.profileManager.RegisterProfile(profile._DBusObject.path, profile.uuid, options, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    registerSerialProfile(listener, mode, options) {
        if (!mode) mode = 'client';
        const obj = this.getUserServiceObject();
        const profile = new SerialProfile(this, obj, listener, options);
        return this.registerProfile(profile, {
            Name: "Node Serial Port",
            Role: mode,
            PSM: 0x0003
        });
    }

    /*
    This registers an agent handler.

    The object path defines the path of the agent
    that will be called when user input is needed.

    Every application can register its own agent and
    for all actions triggered by that application its
    agent is used.

    It is not required by an application to register
    an agent. If an application does chooses to not
    register an agent, the default agent is used. This
    is on most cases a good idea. Only application
    like a pairing wizard should register their own
    agent.

    An application can only register one agent. Multiple
    agents per application is not supported.

    The capability parameter can have the values
    "DisplayOnly", "DisplayYesNo", "KeyboardOnly",
    "NoInputNoOutput" and "KeyboardDisplay" which
    reflects the input and output capabilities of the
    agent.

    If an empty string is used it will fallback to
    "KeyboardDisplay".

    Possible errors: org.bluez.Error.InvalidArguments
                org.bluez.Error.AlreadyExists
    */
    registerAgent(agent, capabilities, requestAsDefault) {
        // assert(agent instance of Agent)
        const self = this;
        return new Promise((resolve, reject) => {
            self.agentManager.RegisterAgent(agent._DBusObject.path, capabilities || "", (err) => {
                if (err) return reject(err);
                if (!requestAsDefault) return resolve();
                self.agentManager.RequestDefaultAgent(agent._DBusObject.path, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    }

    registerDummyAgent(requestAsDefault) {
        const obj = this.getUserServiceObject();
        const agent = new Agent(this, obj);
        return this.registerAgent(agent, "KeyboardDisplay", requestAsDefault);
    }

    getUserService() {
        if (!this.userService) {
            this.userService = DBus.registerService('system', this.options.service);
        }
        return this.userService;
    }

    getUserServiceObject() {
        if (!this.userServiceObject) {
            this.userServiceObject = this.getUserService().createObject(this.options.objectPath);
        }
        return this.userServiceObject;
    }

    async onInterfacesAdded(path, interfaces) {
        // console.log(`Interfaces added: `, path, interfaces);

        const [adapter, dev, service, characteristic] = path.split('/').slice(3);

        if ('org.bluez.Adapter1' in interfaces) {
            const props = interfaces['org.bluez.Adapter1'];
            this.adapter_props = props;
        }
        if ('org.bluez.Device1' in interfaces) {
            const props = interfaces['org.bluez.Device1'];
            this.devices[props.Address] = path;
            this.emit('device', props.Address, props);
        }
        if ('org.bluez.GattService1' in interfaces) {
            const props = interfaces['org.bluez.GattService1'];

            const iface = await this.getInterface('org.bluez', path, 'org.bluez.GattService1');
            const service = new Service(iface);

            const dev = await this.getDevice(props.Device);

            if (this._path[path]) {
                // Characteristic was registered before service, copy them over
                service.characteristics = this._path[path].characteristics || {};
            }

            dev.services[props.UUID] = service;
            this._path[path] = service;
        }
        if ('org.bluez.GattCharacteristic1' in interfaces) {
            const props = interfaces['org.bluez.GattCharacteristic1'];

            const iface = await this.getInterface('org.bluez', path, 'org.bluez.GattCharacteristic1');
            const changed = await this.getInterface('org.bluez', path, 'org.freedesktop.DBus.Properties');
            const characteristic = new Characteristic(iface, changed);

            if (this._path[path]) {
                // Descriptor was registered before characteristic, copy them over
                characteristic.descriptors = this._path[path].descriptors || {};
            }

            if (!this._path[props.Service]) {
                // service not jet created
                this._path[props.Service] = { characteristics: {} };
            }
            this._path[props.Service].characteristics[props.UUID] = characteristic;
            this._path[path] = characteristic;
        }
        if ('org.bluez.GattDescriptor1' in interfaces) {
            const props = interfaces['org.bluez.GattDescriptor1'];

            const iface = await this.getInterface('org.bluez', path, 'org.bluez.GattDescriptor1');
            const descriptor = new Descriptor(iface);

            if (!this._path[props.Characteristic]) {
                // Characteristic not jet created
                this._path[props.Characteristic] = { descriptors: {} };
            }
            this._path[props.Characteristic].descriptors[props.UUID] = descriptor;
        }
    }

    async onPropertiesChanged(path, interfaces) {
        console.log(`Props changes`, path, interfaces);
    }

    async onInterfaceRemoved(path, interfaces/*:string[]*/) {
        const [adapter, dev, service, characteristic] = path.split('/').slice(3);
        const match = path.match(new RegExp("^/org/bluez/(\\w+)(?:/dev_(\\w+))?$"));
        if(interfaces.indexOf('org.bluez.Device1') >= 0) {
            if(match[2]) {
                const addr = match[2].replace(/_/g, ":");
                delete this.devices[addr];
            } else {
                //something is wrong
                this.emit("error", new Error("Removed Device with unknown path"));
            }
        }
        if(interfaces.indexOf('org.bluez.Adapter1') >= 0) {
            if(match[1]) {
                delete this.adapter[match[1]];
            } else {
                //something is wrong
                this.emit("error", new Error("Removed Adapter with unknown path"));
            }
        }
    }
}

module.exports = Bluez;