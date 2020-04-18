import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { LoggingService } from './logging';
import { ConfigService } from './config';
import { StorageService } from './storage';
import { HealthState } from './health';
import { AmsCameraDevice } from './device';
import { Mqtt } from 'azure-iot-device-mqtt';
import { SymmetricKeySecurityClient } from 'azure-iot-security-symmetric-key';
import { ProvisioningDeviceClient } from 'azure-iot-provisioning-device';
import { Mqtt as ProvisioningTransport } from 'azure-iot-provisioning-device-mqtt';
import {
    ModuleClient,
    Twin,
    Message,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    arch as osArch,
    platform as osPlatform,
    release as osRelease,
    cpus as osCpus,
    totalmem as osTotalMem,
    freemem as osFreeMem,
    loadavg as osLoadAvg
} from 'os';
import * as fse from 'fs-extra';
import { resolve as pathResolve } from 'path';
import * as crypto from 'crypto';
import * as ipAddress from 'ip';
import * as _random from 'lodash.random';
import { bind, emptyObj, forget } from '../utils';

type DeviceOperation = 'DELETE_CAMERA' | 'SEND_TELEMETRY' | 'SEND_INFERENCES';

interface ICameraOperationInfo {
    cameraId: string;
    operationInfo: any;
}

interface IProvisionResult {
    dpsProvisionStatus: boolean;
    dpsProvisionMessage: string;
    dpsHubConnectionString: string;
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
    amsCameraDevice: AmsCameraDevice;
}

interface IDeviceOperationResult {
    status: boolean;
    message: string;
}

interface ISystemProperties {
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    totalMemory: number;
    freeMemory: number;
}

enum LvaGatewayDeviceProperties {
    Manufacturer = 'manufacturer',
    Model = 'model',
    SwVersion = 'swVersion',
    OsName = 'osName',
    ProcessorArchitecture = 'processorArchitecture',
    ProcessorManufacturer = 'processorManufacturer',
    TotalStorage = 'totalStorage',
    TotalMemory = 'totalMemory'
}

enum LvaGatewaySettings {
    MasterDeviceProvisioningKey = 'wpMasterDeviceProvisioningKey',
    ScopeId = 'wpScopeId',
    DeviceTemplateId = 'wpDeviceTemplateId',
    GatewayInstanceId = 'wpGatewayInstanceId',
    GatewayModuleId = 'wpGatewayModuleId',
    LvaEdgeModuleId = 'wpLvaEdgeModuleId'
}

interface ILvaGatewaySettings {
    [LvaGatewaySettings.MasterDeviceProvisioningKey]: string;
    [LvaGatewaySettings.ScopeId]: string;
    [LvaGatewaySettings.DeviceTemplateId]: string;
    [LvaGatewaySettings.GatewayInstanceId]: string;
    [LvaGatewaySettings.GatewayModuleId]: string;
    [LvaGatewaySettings.LvaEdgeModuleId]: string;
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum ModuleState {
    Inactive = 'inactive',
    Active = 'active'
}

enum RestartModuleCommandRequestParams {
    Timeout = 'RestartModuleRequestParams_Timeout'
}

enum AddCameraCommandRequestParams {
    CameraId = 'AddCameraRequestParams_CameraId',
    CameraName = 'AddCameraRequestParams_CameraName'
}

const LvaGatewayInterface = {
    Telemetry: {
        SystemHeartbeat: 'tlSystemHeartbeat',
        FreeMemory: 'tlFreeMemory'
    },
    State: {
        IoTCentralClientState: 'stIoTCentralClientState',
        ModuleState: 'stModuleState'
    },
    Event: {
        CreateCamera: 'evCreateCamera',
        DeleteCamera: 'evDeleteCamera',
        ModuleStarted: 'evModuleStarted',
        ModuleStopped: 'evModuleStopped',
        ModuleRestart: 'evModuleRestart'
    },
    Setting: {
        MasterDeviceProvisioningKey: LvaGatewaySettings.MasterDeviceProvisioningKey,
        ScopeId: LvaGatewaySettings.ScopeId,
        DeviceTemplateId: LvaGatewaySettings.DeviceTemplateId,
        GatewayInstanceId: LvaGatewaySettings.GatewayInstanceId,
        GatewayModuleId: LvaGatewaySettings.GatewayModuleId,
        LvaEdgeModuleId: LvaGatewaySettings.LvaEdgeModuleId
    },
    Property: {
        ModuleIpAddress: 'rpModuleIpAddress'
    },
    Command: {
        RestartModule: 'cmRestartModule',
        AddCamera: 'cmAddCamera'
    }
};

const LvaGatewayEdgeInputs = {
    CameraCommand: 'cameracommand',
    LvaTelemetry: 'lvaTelemetry'
};

const LvaGatewayCommands = {
    CreateCamera: 'createcamera',
    DeleteCamera: 'deletecamera',
    SendDeviceTelemetry: 'senddevicetelemetry',
    SendDeviceInferences: 'senddeviceinferences'
};

const defaultDpsProvisioningHost: string = 'global.azure-devices-provisioning.net';
const defaultHealthCheckRetries: number = 3;

@service('module')
export class ModuleService {
    @inject('$server')
    private server: Server;

    @inject('logger')
    private logger: LoggingService;

    @inject('config')
    private config: ConfigService;

    @inject('storage')
    private storage: StorageService;

    private iotcModuleId: string = '';
    private moduleClient: ModuleClient = null;
    private moduleTwin: Twin = null;
    private healthState = HealthState.Good;
    private healthCheckFailStreak: number = 0;
    private moduleIpAddress: string = '127.0.0.1';
    private moduleSettings: ILvaGatewaySettings = {
        [LvaGatewaySettings.MasterDeviceProvisioningKey]: '',
        [LvaGatewaySettings.ScopeId]: '',
        [LvaGatewaySettings.DeviceTemplateId]: '',
        [LvaGatewaySettings.GatewayInstanceId]: '',
        [LvaGatewaySettings.GatewayModuleId]: '',
        [LvaGatewaySettings.LvaEdgeModuleId]: ''
    };
    private moduleSettingsDefaults: ILvaGatewaySettings = {
        [LvaGatewaySettings.MasterDeviceProvisioningKey]: '',
        [LvaGatewaySettings.ScopeId]: '',
        [LvaGatewaySettings.DeviceTemplateId]: '',
        [LvaGatewaySettings.GatewayInstanceId]: '',
        [LvaGatewaySettings.GatewayModuleId]: '',
        [LvaGatewaySettings.LvaEdgeModuleId]: ''
    };
    private amsCameraDeviceMap = new Map<string, AmsCameraDevice>();
    private dpsProvisioningHost: string = defaultDpsProvisioningHost;
    private healthCheckRetries: number = defaultHealthCheckRetries;

    public async init(): Promise<void> {
        this.logger.log(['ModuleService', 'info'], 'initialize');

        this.server.method({ name: 'module.startModule', method: this.startModule });

        this.iotcModuleId = this.config.get('IOTEDGE_MODULEID') || '';

        this.moduleIpAddress = ipAddress.address() || '127.0.0.1';

        this.dpsProvisioningHost = this.config.get('dpsProvisioningHost') || defaultDpsProvisioningHost;
        this.healthCheckRetries = this.config.get('healthCheckRetries') || defaultHealthCheckRetries;
    }

    @bind
    public async startModule(): Promise<void> {
        let result = true;

        try {
            result = await this.connectModuleClient();
        }
        catch (ex) {
            result = false;

            this.logger.log(['ModuleService', 'error'], `Exception during IoT Central device provsioning: ${ex.message}`);
        }

        this.healthState = result === true ? HealthState.Good : HealthState.Critical;
    }

    public async createCamera(cameraId: string, cameraName: string): Promise<IProvisionResult> {
        return this.createAmsCameraDevice(cameraId, cameraName);
    }

    public async deleteCamera(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.amsCameraDeviceOperation('DELETE_CAMERA', cameraOperationInfo);
    }

    public async sendCameraTelemetry(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.amsCameraDeviceOperation('SEND_TELEMETRY', cameraOperationInfo);
    }

    public async sendCameraInferences(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.amsCameraDeviceOperation('SEND_INFERENCES', cameraOperationInfo);
    }

    @bind
    public async getHealth(): Promise<number> {
        let healthState = HealthState.Good;

        try {
            const systemProperties = await this.getSystemProperties();
            const freeMemory = systemProperties?.freeMemory || 0;

            await this.sendMeasurement({ [LvaGatewayInterface.Telemetry.FreeMemory]: freeMemory });

            // TODO:
            // Find the right threshold for this metric
            if (freeMemory === 0) {
                healthState = HealthState.Critical;
            }

            await this.sendMeasurement({ [LvaGatewayInterface.Telemetry.SystemHeartbeat]: healthState });

            if (healthState < HealthState.Good) {
                this.logger.log(['HealthService', 'warning'], `Health check watch: ${healthState}`);

                if (++this.healthCheckFailStreak >= this.healthCheckRetries) {
                    await this.restartModule(10, 'checkHealthState');
                }
            }

            this.healthState = healthState;

            for (const device of this.amsCameraDeviceMap) {
                forget(device[1].getHealth);
            }
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `Error computing healthState: ${ex.message}`);
            healthState = HealthState.Critical;
        }

        return this.healthState;
    }

    @bind
    public async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.moduleClient) {
            return;
        }

        try {
            const iotcMessage = new Message(JSON.stringify(data));

            await this.moduleClient.sendOutputEvent('iotc', iotcMessage);

            if (process.env.DEBUG_MODULE_TELEMETRY === '1') {
                this.logger.log(['ModuleService', 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `sendMeasurement: ${ex.message}`);
        }
    }

    public async sendInferenceData(inferenceTelemetryData: any) {
        if (!inferenceTelemetryData || !this.moduleClient) {
            return;
        }

        try {
            await this.sendMeasurement(inferenceTelemetryData);
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `sendInferenceData: ${ex.message}`);
        }
    }

    @bind
    public async invokeMethod(methodParams: any) {
        await this.moduleClient.invokeMethod(this.moduleSettings[LvaGatewaySettings.GatewayInstanceId], this.moduleSettings[LvaGatewaySettings.LvaEdgeModuleId], methodParams);
    }

    public async restartModule(timeout: number, reason: string): Promise<void> {
        this.logger.log(['ModuleService', 'info'], `Module restart requested...`);

        try {
            await this.sendMeasurement({
                [LvaGatewayInterface.Event.ModuleRestart]: reason,
                [LvaGatewayInterface.State.ModuleState]: ModuleState.Inactive
            });

            if (timeout > 0) {
                await new Promise((resolve) => {
                    setTimeout(() => {
                        return resolve();
                    }, 1000 * timeout);
                });
            }
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `${ex.message}`);
        }

        // let Docker restart our container
        this.logger.log(['ModuleService', 'error'], `Exiting container now`);
        process.exit(1);
    }

    private async getSystemProperties(): Promise<ISystemProperties> {
        const cpus = osCpus();
        const cpuUsageSamples = osLoadAvg();

        return {
            cpuModel: cpus[0]?.model || 'Unknown',
            cpuCores: cpus?.length || 0,
            cpuUsage: cpuUsageSamples[0],
            totalMemory: osTotalMem() / 1024,
            freeMemory: osFreeMem() / 1024
        };
    }

    private async getModuleProperties(): Promise<any> {
        let result = {};

        try {
            result = await this.storage.get('state', 'iotCentral.properties');
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `Error reading module properties: ${ex.message}`);
        }

        return result;
    }

    private async connectModuleClient(): Promise<boolean> {
        let result = true;
        let connectionStatus = `IoT Central successfully connected module: ${this.iotcModuleId}`;

        if (this.moduleClient) {
            await this.moduleClient.close();
            this.moduleClient = null;
            this.moduleTwin = null;
        }

        try {
            this.logger.log(['ModuleService', 'info'], `IOTEDGE_WORKLOADURI: ${this.config.get('IOTEDGE_WORKLOADURI')}`);
            this.logger.log(['ModuleService', 'info'], `IOTEDGE_DEVICEID: ${this.config.get('IOTEDGE_DEVICEID')}`);
            this.logger.log(['ModuleService', 'info'], `IOTEDGE_MODULEID: ${this.config.get('IOTEDGE_MODULEID')}`);
            this.logger.log(['ModuleService', 'info'], `IOTEDGE_MODULEGENERATIONID: ${this.config.get('IOTEDGE_MODULEGENERATIONID')}`);
            this.logger.log(['ModuleService', 'info'], `IOTEDGE_IOTHUBHOSTNAME: ${this.config.get('IOTEDGE_IOTHUBHOSTNAME')}`);
            this.logger.log(['ModuleService', 'info'], `IOTEDGE_AUTHSCHEME: ${this.config.get('IOTEDGE_AUTHSCHEME')}`);

            this.moduleClient = await ModuleClient.fromEnvironment(Mqtt);
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `Failed to instantiate client interface from configuraiton: ${ex.message}`);
        }

        if (!this.moduleClient) {
            result = false;
        }

        if (result === true) {
            try {
                await this.moduleClient.open();

                this.logger.log(['ModuleService', 'info'], `Client is connected`);

                // TODO:
                // Should the module twin interface get connected *BEFORE* opening
                // the moduleClient above?
                this.moduleTwin = await this.moduleClient.getTwin();
                this.moduleTwin.on('properties.desired', this.onHandleModuleProperties);

                this.moduleClient.on('error', this.onModuleClientError);

                this.moduleClient.onMethod(LvaGatewayInterface.Command.RestartModule, this.restartModuleDirectMethod);
                this.moduleClient.onMethod(LvaGatewayInterface.Command.AddCamera, this.addCameraDirectMethod);
                this.moduleClient.on('inputMessage', this.onHandleDownstreamMessages);

                const systemProperties = await this.getSystemProperties();
                const moduleProperties = await this.getModuleProperties();

                const deviceProperties = {
                    ...moduleProperties,
                    [LvaGatewayDeviceProperties.OsName]: osPlatform() || '',
                    [LvaGatewayDeviceProperties.SwVersion]: osRelease() || '',
                    [LvaGatewayDeviceProperties.ProcessorArchitecture]: osArch() || '',
                    [LvaGatewayDeviceProperties.TotalMemory]: systemProperties.totalMemory,
                    [LvaGatewayInterface.Property.ModuleIpAddress]: this.moduleIpAddress
                };

                await this.updateModuleProperties(deviceProperties);

                await this.sendMeasurement({
                    [LvaGatewayInterface.State.IoTCentralClientState]: IoTCentralClientState.Connected,
                    [LvaGatewayInterface.State.ModuleState]: ModuleState.Active
                });
            }
            catch (ex) {
                connectionStatus = `IoT Central connection error: ${ex.message}`;
                this.logger.log(['ModuleService', 'error'], connectionStatus);

                result = false;
            }
        }

        return result;
    }

    @bind
    private async onHandleDownstreamMessages(inputName: string, message: any) {
        // this.logger.log(['ModuleService', 'info'], `Received downstream message: ${JSON.stringify(message, null, 4)}`);

        if (!this.moduleClient) {
            return;
        }

        try {
            await this.moduleClient.complete(message);

            const messageData = message.getBytes().toString('utf8');
            if (!messageData) {
                return;
            }

            const messageJson = JSON.parse(messageData);

            switch (inputName) {
                case LvaGatewayEdgeInputs.CameraCommand: {
                    const edgeInputCameraCommand = messageJson?.command;
                    const edgeInputCameraCommandData = messageJson?.data;

                    switch (edgeInputCameraCommand) {
                        case LvaGatewayCommands.CreateCamera:
                            await this.createAmsCameraDevice(edgeInputCameraCommandData?.cameraId, edgeInputCameraCommandData?.cameraName);
                            break;

                        case LvaGatewayCommands.DeleteCamera:
                            await this.amsCameraDeviceOperation('DELETE_CAMERA', edgeInputCameraCommandData);
                            break;

                        case LvaGatewayCommands.SendDeviceTelemetry:
                            await this.amsCameraDeviceOperation('SEND_TELEMETRY', edgeInputCameraCommandData);
                            break;

                        case LvaGatewayCommands.SendDeviceInferences:
                            await this.amsCameraDeviceOperation('SEND_INFERENCES', edgeInputCameraCommandData);
                            break;

                        default:
                            this.logger.log(['ModuleService', 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
                            break;
                    }

                    break;
                }

                case LvaGatewayEdgeInputs.LvaTelemetry:
                    break;

                default:
                    this.logger.log(['ModuleService', 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
                    break;
            }
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `Error while handling downstream message: ${ex.message}`);
        }
    }

    private async createAmsCameraDevice(cameraId: string, cameraName: string): Promise<IProvisionResult> {
        this.logger.log(['ModuleService', 'info'], `createAmsCameraDevice - cameraId: ${cameraId}, cameraName: ${cameraName}`);

        let deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            amsCameraDevice: null
        };

        try {
            if (!cameraId) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing device configuration - skipping DPS provisioning`;

                this.logger.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            if (!this.moduleSettings[LvaGatewaySettings.MasterDeviceProvisioningKey]
                || !this.moduleSettings[LvaGatewaySettings.ScopeId]
                || !this.moduleSettings[LvaGatewaySettings.DeviceTemplateId]
                || !this.moduleSettings[LvaGatewaySettings.GatewayInstanceId]
                || !this.moduleSettings[LvaGatewaySettings.GatewayModuleId]) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing camera management settings (Master provision key, scopeId, deviceTemplateId, gatewayInstanceId, gatewayModuleId)`;
                this.logger.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            deviceProvisionResult = await this.createAndProvisionAmsCameraDevice(cameraId, cameraName);
            if (deviceProvisionResult.dpsProvisionStatus === true && deviceProvisionResult.clientConnectionStatus === true) {
                this.logger.log(['ModuleService', 'info'], `Succesfully provisioned camera device with id: ${cameraId}`);

                this.amsCameraDeviceMap.set(cameraId, deviceProvisionResult.amsCameraDevice);

                await this.sendMeasurement({ [LvaGatewayInterface.Event.CreateCamera]: cameraId });
            }
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while processing downstream message: ${ex.message}`;

            this.logger.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async createAndProvisionAmsCameraDevice(cameraId: string, cameraName: string): Promise<IProvisionResult> {
        this.logger.log(['ModuleService', 'info'], `Provisioning new device - id: ${cameraId}`);

        const deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            amsCameraDevice: null
        };

        try {
            const deviceKey = this.computeDeviceKey(cameraId, this.moduleSettings[LvaGatewaySettings.MasterDeviceProvisioningKey]);
            const provisioningSecurityClient = new SymmetricKeySecurityClient(cameraId, deviceKey);
            const provisioningClient = ProvisioningDeviceClient.create(
                this.dpsProvisioningHost,
                this.moduleSettings[LvaGatewaySettings.ScopeId],
                new ProvisioningTransport(),
                provisioningSecurityClient);

            provisioningClient.setProvisioningPayload({
                iotcModelId: this.moduleSettings[LvaGatewaySettings.DeviceTemplateId],
                iotcGateway: {
                    iotcGatewayId: this.moduleSettings[LvaGatewaySettings.GatewayInstanceId],
                    iotcModuleId: this.moduleSettings[LvaGatewaySettings.GatewayModuleId]
                }
            });

            const dpsConnectionString = await new Promise<string>((resolve, reject) => {
                provisioningClient.register((dpsError, dpsResult) => {
                    if (dpsError) {
                        return reject(dpsError);
                    }

                    this.logger.log(['ModuleService', 'info'], `DPS registration succeeded - hub: ${dpsResult.assignedHub}`);

                    return resolve(`HostName=${dpsResult.assignedHub};DeviceId=${dpsResult.deviceId};SharedAccessKey=${deviceKey}`);
                });
            });

            deviceProvisionResult.dpsProvisionStatus = true;
            deviceProvisionResult.dpsProvisionMessage = `IoT Central successfully provisioned device: ${cameraId}`;
            deviceProvisionResult.dpsHubConnectionString = dpsConnectionString;

            deviceProvisionResult.amsCameraDevice = new AmsCameraDevice(this.server.log, this.invokeMethod, this.graphInstance, this.graphTopology, cameraId, cameraName);

            const { clientConnectionStatus, clientConnectionMessage } = await deviceProvisionResult.amsCameraDevice.connectDeviceClient(deviceProvisionResult.dpsHubConnectionString);
            deviceProvisionResult.clientConnectionStatus = clientConnectionStatus;
            deviceProvisionResult.clientConnectionMessage = clientConnectionMessage;
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.logger.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private computeDeviceKey(deviceId: string, masterKey: string) {
        return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64')).update(deviceId, 'utf8').digest('base64');
    }

    private loadCameraGraph(graphType: string) {
        const graphInstancePath = pathResolve(this.server?.settings?.app?.storageRootDirectory, `${graphName}GraphInstance.json`);
        const graphInstance = fse.readJSONSync(graphInstancePath);

        graphInstance.name = (graphInstance?.name || '').replace('###RtspCameraId', deviceProps.cameraId);
        graphInstance.properties.topologyName = (graphInstance?.properties?.topologyName || '###RtspCameraId').replace('###RtspCameraId', deviceProps.cameraId);

        this.logger.log(['ModuleService', 'info'], `### graphFilePath: ${graphInstancePath}`);
        this.logger.log(['ModuleService', 'info'], `### graphData: ${JSON.stringify(graphInstance, null, 4)}`);

        const graphTopologyPath = pathResolve(this.server?.settings?.app?.storageRootDirectory, `${graphName}GraphTopology.json`);
        const graphTopology = fse.readJSONSync(graphTopologyPath);

        graphTopology.name = (graphTopology?.name || '').replace('###RtspCameraId', deviceProps.cameraId);
        graphTopology.properties.sources[0].name = deviceProps.cameraId;
        graphTopology.properties.sources[0].endpoint.url = deviceProps.rtspUrl;
        graphTopology.properties.sources[0].endpoint.credentials.username = deviceProps.rtspAuthUsername;
        graphTopology.properties.sources[0].endpoint.credentials.password = deviceProps.rtspAuthPassword;
        graphTopology.properties.processors[0].inputs[1].moduleName = deviceProps.cameraId;
        graphTopology.properties.sinks[0].filePathPattern = (graphTopology?.properties?.sinks[0]?.filePathPattern || '###RtspCameraId').replace('###RtspCameraId', deviceProps.cameraId);

        this.logger.log(['ModuleService', 'info'], `### graphFilePath: ${graphTopologyPath}`);
        this.logger.log(['ModuleService', 'info'], `### graphData: ${JSON.stringify(graphTopology, null, 4)}`);
    }

    private async amsCameraDeviceOperation(deviceOperation: DeviceOperation, cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        this.logger.log(['ModuleService', 'info'], `Processing LVA Edge gateway operation: ${JSON.stringify(cameraOperationInfo, null, 4)}`);

        const operationResult = {
            status: false,
            message: ''
        };

        const cameraId = cameraOperationInfo?.cameraId;
        if (!cameraId) {
            operationResult.message = `Error: missing cameraId`;

            this.logger.log(['ModuleService', 'error'], operationResult.message);

            return operationResult;
        }

        const amsCameraDevice = this.amsCameraDeviceMap.get(cameraId);
        if (!amsCameraDevice) {
            operationResult.message = `Error: Not device exists with cameraId: ${cameraId}`;

            this.logger.log(['ModuleService', 'error'], operationResult.message);

            return operationResult;
        }

        const operationInfo = cameraOperationInfo?.operationInfo;
        if (!operationInfo) {
            operationResult.message = `Error: missing operationInfo data`;

            this.logger.log(['ModuleService', 'error'], operationResult.message);

            return operationResult;
        }

        switch (deviceOperation) {
            case 'DELETE_CAMERA':
                await this.sendMeasurement({ [LvaGatewayInterface.Event.DeleteCamera]: cameraId });

                await amsCameraDevice.deleteCamera();
                break;

            case 'SEND_TELEMETRY':
                await amsCameraDevice.sendTelemetry(operationInfo);
                break;

            case 'SEND_INFERENCES':
                await amsCameraDevice.processLvaInferences(operationInfo);
                break;

            default:
                this.logger.log(['ModuleService', 'error'], `Unkonwn device operation: ${deviceOperation}`);
                break;
        }

        return {
            status: true,
            message: `Success`
        };
    }

    @bind
    private onModuleClientError(error: Error) {
        this.logger.log(['ModuleService', 'error'], `Module client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    private async updateModuleProperties(properties: any): Promise<void> {
        if (!properties || !this.moduleTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.moduleTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve();
                });
            });

            this.logger.log(['ModuleService', 'info'], `Module properties updated: ${JSON.stringify(properties, null, 4)}`);
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `Error updating module properties: ${ex.message}`);
        }
    }

    @bind
    private async onHandleModuleProperties(desiredChangedSettings: any) {
        this.logger.log(['ModuleService', 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);

        const patchedProperties = {};
        const moduleSettingsForPatching = this.getModuleSettingsForPatching();

        for (const desiredSettingsKey in desiredChangedSettings) {
            if (!desiredChangedSettings.hasOwnProperty(desiredSettingsKey)) {
                continue;
            }

            if (desiredSettingsKey === '$version') {
                continue;
            }

            try {
                let changedSettingResult;

                switch (desiredSettingsKey) {
                    case LvaGatewayInterface.Setting.MasterDeviceProvisioningKey:
                    case LvaGatewayInterface.Setting.ScopeId:
                    case LvaGatewayInterface.Setting.DeviceTemplateId:
                    case LvaGatewayInterface.Setting.GatewayInstanceId:
                    case LvaGatewayInterface.Setting.GatewayModuleId:
                    case LvaGatewayInterface.Setting.LvaEdgeModuleId:
                        changedSettingResult = await this.moduleSettingChange(moduleSettingsForPatching, desiredSettingsKey, desiredChangedSettings?.[`${desiredSettingsKey}`]);
                        break;

                    default:
                        this.logger.log(['ModuleService', 'error'], `Received desired property change for unknown setting '${desiredSettingsKey}'`);
                        break;
                }

                if (changedSettingResult?.status === true) {
                    patchedProperties[desiredSettingsKey] = changedSettingResult?.value;
                }
            }
            catch (ex) {
                this.logger.log(['ModuleService', 'error'], `Exception while handling desired properties: ${ex.message}`);
            }
        }

        for (const moduleSettingsKey in moduleSettingsForPatching) {
            if (!moduleSettingsForPatching.hasOwnProperty(moduleSettingsKey)) {
                continue;
            }

            if (!moduleSettingsForPatching[moduleSettingsKey].handled) {
                this.logger.log(['ModuleService', 'info'], `Adding patched property '${moduleSettingsKey}' setting value to: '${this.moduleSettingsDefaults[moduleSettingsKey]}'`);
                patchedProperties[moduleSettingsKey] = this.moduleSettingsDefaults[moduleSettingsKey];
            }

            this.moduleSettings[moduleSettingsKey] = moduleSettingsForPatching[moduleSettingsKey].value;
        }

        if (!emptyObj(patchedProperties)) {
            await this.updateModuleProperties(patchedProperties);
        }
    }

    private getModuleSettingsForPatching() {
        const moduleSettingsForPatching = {};

        for (const moduleSettingsKey in this.moduleSettings) {
            if (!this.moduleSettings.hasOwnProperty(moduleSettingsKey)) {
                continue;
            }

            moduleSettingsForPatching[moduleSettingsKey] = {
                handled: false,
                value: this.moduleSettings[moduleSettingsKey]
            };
        }

        return moduleSettingsForPatching;
    }

    private async moduleSettingChange(moduleSettingsForPatching: any, setting: string, value: any): Promise<any> {
        this.logger.log(['ModuleService', 'info'], `Handle module setting change for '${setting}': ${typeof value === 'object' && value !== null ? JSON.stringify(value, null, 4) : value}`);

        const result = {
            value: undefined,
            status: true
        };

        switch (setting) {
            case LvaGatewayInterface.Setting.MasterDeviceProvisioningKey:
            case LvaGatewayInterface.Setting.ScopeId:
            case LvaGatewayInterface.Setting.DeviceTemplateId:
            case LvaGatewayInterface.Setting.GatewayInstanceId:
            case LvaGatewayInterface.Setting.GatewayModuleId:
            case LvaGatewayInterface.Setting.LvaEdgeModuleId:
                result.value = moduleSettingsForPatching[setting].value = value || '';
                moduleSettingsForPatching[setting].handled = true;
                break;

            default:
                this.logger.log(['ModuleService', 'info'], `Unknown module setting change request '${setting}'`);
                result.status = false;
        }

        return result;
    }

    @bind
    private async restartModuleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.logger.log(['ModuleService', 'info'], `${LvaGatewayInterface.Command.RestartModule} command received`);

        try {
            // sending response before processing, since this is a restart request
            await commandResponse.send(200, {
                statusCode: 201,
                message: 'Success'
            });

            const paramPayload = commandRequest?.payload;
            if (typeof paramPayload !== 'object') {
                throw new Error(`Missing or wrong payload time for command`);
            }

            await this.restartModule(paramPayload?.[RestartModuleCommandRequestParams.Timeout] || 0, 'RestartModule command received');
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `Error sending response for ${LvaGatewayInterface.Command.RestartModule} command: ${ex.message}`);
        }
    }

    @bind
    // @ts-ignore
    private async addCameraDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.logger.log(['ModuleService', 'info'], `${LvaGatewayInterface.Command.AddCamera} command received`);

        try {
            const paramPayload = commandRequest?.payload;
            if (typeof paramPayload !== 'object') {
                throw new Error(`Missing or wrong payload time for command: ${LvaGatewayInterface.Command.AddCamera}`);
            }

            const cameraId = paramPayload?.[AddCameraCommandRequestParams.CameraId];
            const cameraName = paramPayload?.[AddCameraCommandRequestParams.CameraName];

            const provisionResult = await this.createAmsCameraDevice(cameraId, cameraName);

            const statusCode = (provisionResult.dpsProvisionStatus === true && provisionResult.clientConnectionStatus === true) ? 201 : 400;

            await commandResponse.send(statusCode, {
                statusCode,
                message: provisionResult.clientConnectionMessage
            });
        }
        catch (ex) {
            this.logger.log(['ModuleService', 'error'], `Error creating LVA Edge gateway camera device: ${ex.message}`);

            await commandResponse.send(400, {
                statusCode: 400,
                message: ex.message
            });
        }
    }
}
