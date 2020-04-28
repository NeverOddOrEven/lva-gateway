import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { ConfigService } from './config';
import { StorageService } from './storage';
import { HealthState } from './health';
import { AmsDeviceTag, AmsDeviceTagValue, AmsCameraDevice } from './device';
import { AmsMotionDetectorDevice } from './motionDetectorDevice';
import { AmsObjectDetectorDevice } from './objectDetectorDevice';
import { Mqtt } from 'azure-iot-device-mqtt';
import { SymmetricKeySecurityClient } from 'azure-iot-security-symmetric-key';
import { ProvisioningDeviceClient } from 'azure-iot-provisioning-device';
import { Mqtt as ProvisioningTransport } from 'azure-iot-provisioning-device-mqtt';
import {
    ModuleClient,
    Twin,
    Message as IoTMessage,
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
import * as Wreck from '@hapi/wreck';
import * as _random from 'lodash.random';
import { bind, defer, emptyObj, forget } from '../utils';

export interface IAmsGraph {
    initialized: boolean;
    instance: any;
    topology: any;
}

export interface ICommandResponse {
    statusCode: number;
    message: string;
}

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
    amsInferenceDevice: AmsCameraDevice;
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
    IoTCentralAppHost = 'wpIoTCentralAppHost',
    IoTCentralAppApiToken = 'wpIoTCentralAppApiToken',
    MasterDeviceProvisioningKey = 'wpMasterDeviceProvisioningKey',
    ScopeId = 'wpScopeId',
    GatewayInstanceId = 'wpGatewayInstanceId',
    GatewayModuleId = 'wpGatewayModuleId',
    LvaEdgeModuleId = 'wpLvaEdgeModuleId',
    DebugTelemetry = 'wpDebugTelemetry',
    DebugRoutedMessage = 'wpDebugRoutedMessage'
}

interface ILvaGatewaySettings {
    [LvaGatewaySettings.IoTCentralAppHost]: string;
    [LvaGatewaySettings.IoTCentralAppApiToken]: string;
    [LvaGatewaySettings.MasterDeviceProvisioningKey]: string;
    [LvaGatewaySettings.ScopeId]: string;
    [LvaGatewaySettings.GatewayInstanceId]: string;
    [LvaGatewaySettings.GatewayModuleId]: string;
    [LvaGatewaySettings.LvaEdgeModuleId]: string;
    [LvaGatewaySettings.DebugTelemetry]: boolean;
    [LvaGatewaySettings.DebugRoutedMessage]: boolean;
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
    CameraName = 'AddCameraRequestParams_CameraName',
    DetectionType = 'AddCameraRequestParams_DetectionType'
}

enum AddCameraDetectionType {
    Motion = 'motion',
    Object = 'object'
}

const LvaInferenceDeviceMap = {
    motion: {
        templateId: 'urn:AzureMediaServices:LvaEdgeMotionDetectorDevice:1',
        deviceClass: AmsMotionDetectorDevice
    },
    object: {
        templateId: 'urn:AzureMediaServices:LvaEdgeObjectDetectorDevice:1',
        deviceClass: AmsObjectDetectorDevice
    }
};

const LvaGatewayInterface = {
    Telemetry: {
        SystemHeartbeat: 'tlSystemHeartbeat',
        FreeMemory: 'tlFreeMemory',
        ConnectedCameras: 'tlConnectedCameras'
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
        IoTCentralAppHost: LvaGatewaySettings.IoTCentralAppHost,
        IoTCentralAppApiToken: LvaGatewaySettings.IoTCentralAppApiToken,
        MasterDeviceProvisioningKey: LvaGatewaySettings.MasterDeviceProvisioningKey,
        ScopeId: LvaGatewaySettings.ScopeId,
        GatewayInstanceId: LvaGatewaySettings.GatewayInstanceId,
        GatewayModuleId: LvaGatewaySettings.GatewayModuleId,
        LvaEdgeModuleId: LvaGatewaySettings.LvaEdgeModuleId,
        DebugTelemetry: LvaGatewaySettings.DebugTelemetry,
        DebugRoutedMessage: LvaGatewaySettings.DebugRoutedMessage
    },
    Command: {
        RestartModule: 'cmRestartModule',
        AddCamera: 'cmAddCamera'
    }
};

const LvaGatewayEdgeInputs = {
    CameraCommand: 'cameracommand',
    LvaDiagnostics: 'lvaDiagnostics',
    LvaOperational: 'lvaOperational',
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

    @inject('config')
    private config: ConfigService;

    @inject('storage')
    private storage: StorageService;

    private iotcModuleId: string = '';
    private moduleClient: ModuleClient = null;
    private moduleTwin: Twin = null;
    private deferredStart = defer();
    private healthState = HealthState.Good;
    private healthCheckFailStreak: number = 0;
    private moduleSettings: ILvaGatewaySettings = {
        [LvaGatewaySettings.IoTCentralAppHost]: '',
        [LvaGatewaySettings.IoTCentralAppApiToken]: '',
        [LvaGatewaySettings.MasterDeviceProvisioningKey]: '',
        [LvaGatewaySettings.ScopeId]: '',
        [LvaGatewaySettings.GatewayInstanceId]: '',
        [LvaGatewaySettings.GatewayModuleId]: '',
        [LvaGatewaySettings.LvaEdgeModuleId]: '',
        [LvaGatewaySettings.DebugTelemetry]: false,
        [LvaGatewaySettings.DebugRoutedMessage]: false
    };
    private moduleSettingsDefaults: ILvaGatewaySettings = {
        [LvaGatewaySettings.IoTCentralAppHost]: '',
        [LvaGatewaySettings.IoTCentralAppApiToken]: '',
        [LvaGatewaySettings.MasterDeviceProvisioningKey]: '',
        [LvaGatewaySettings.ScopeId]: '',
        [LvaGatewaySettings.GatewayInstanceId]: '',
        [LvaGatewaySettings.GatewayModuleId]: '',
        [LvaGatewaySettings.LvaEdgeModuleId]: '',
        [LvaGatewaySettings.DebugTelemetry]: false,
        [LvaGatewaySettings.DebugRoutedMessage]: false
    };
    private amsInferenceDeviceMap = new Map<string, AmsCameraDevice>();
    private dpsProvisioningHost: string = defaultDpsProvisioningHost;
    private healthCheckRetries: number = defaultHealthCheckRetries;

    public async init(): Promise<void> {
        this.server.log(['ModuleService', 'info'], 'initialize');

        this.server.method({ name: 'module.startModule', method: this.startModule });

        this.iotcModuleId = this.config.get('IOTEDGE_MODULEID') || '';

        this.dpsProvisioningHost = this.config.get('dpsProvisioningHost') || defaultDpsProvisioningHost;
        this.healthCheckRetries = this.config.get('healthCheckRetries') || defaultHealthCheckRetries;
    }

    @bind
    public async startModule(): Promise<void> {
        let result = true;

        try {
            result = await this.connectModuleClient();

            if (result === true) {
                await this.deferredStart.promise;
            }
        }
        catch (ex) {
            result = false;

            this.server.log(['ModuleService', 'error'], `Exception during IoT Central device provsioning: ${ex.message}`);
        }

        this.healthState = result === true ? HealthState.Good : HealthState.Critical;
    }

    public log(tags: any, message: any) {
        this.server.log(tags, message);
    }

    public async createCamera(cameraId: string, cameraName: string, detectionType: AddCameraDetectionType): Promise<IProvisionResult> {
        return this.createAmsInferenceDevice(cameraId, cameraName, detectionType);
    }

    public async deleteCamera(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.amsInferenceDeviceOperation('DELETE_CAMERA', cameraOperationInfo);
    }

    public async sendCameraTelemetry(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.amsInferenceDeviceOperation('SEND_TELEMETRY', cameraOperationInfo);
    }

    public async sendCameraInferences(cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        return this.amsInferenceDeviceOperation('SEND_INFERENCES', cameraOperationInfo);
    }

    @bind
    public async getHealth(): Promise<number> {
        let healthState = HealthState.Good;

        try {
            const systemProperties = await this.getSystemProperties();
            const freeMemory = systemProperties?.freeMemory || 0;

            await this.sendMeasurement({
                [LvaGatewayInterface.Telemetry.FreeMemory]: freeMemory,
                [LvaGatewayInterface.Telemetry.ConnectedCameras]: this.amsInferenceDeviceMap.size
            });

            // TODO:
            // Find the right threshold for this metric
            if (freeMemory === 0) {
                healthState = HealthState.Critical;
            }

            await this.sendMeasurement({ [LvaGatewayInterface.Telemetry.SystemHeartbeat]: healthState });

            if (healthState < HealthState.Good) {
                this.server.log(['HealthService', 'warning'], `Health check watch: ${healthState}`);

                if (++this.healthCheckFailStreak >= this.healthCheckRetries) {
                    await this.restartModule(10, 'checkHealthState');
                }
            }

            this.healthState = healthState;

            for (const device of this.amsInferenceDeviceMap) {
                forget(device[1].getHealth);
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error computing healthState: ${ex.message}`);
            healthState = HealthState.Critical;
        }

        return this.healthState;
    }

    public async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.moduleClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.moduleClient.sendOutputEvent('iotc', iotcMessage);

            if (this.moduleSettings[LvaGatewaySettings.DebugTelemetry] === true) {
                this.server.log(['ModuleService', 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `sendMeasurement: ${ex.message}`);
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
            this.server.log(['ModuleService', 'error'], `sendInferenceData: ${ex.message}`);
        }
    }

    public async loadAmsGraph(detectionType: AddCameraDetectionType): Promise<IAmsGraph> {
        let graphInstance;
        let graphTopology;

        try {
            const contentRoot = (this.server?.settings?.app as any)?.contentRootDirectory;

            const graphInstancePath = pathResolve(contentRoot, `${detectionType}GraphInstance.json`);
            graphInstance = fse.readJSONSync(graphInstancePath);

            this.server.log(['ModuleService', 'info'], `### graphFilePath: ${graphInstancePath}`);
            // this.server.log(['ModuleService', 'info'], `### graphData: ${JSON.stringify(graphInstance, null, 4)}`);

            const graphTopologyPath = pathResolve(contentRoot, `${detectionType}GraphTopology.json`);
            graphTopology = fse.readJSONSync(graphTopologyPath);

            this.server.log(['ModuleService', 'info'], `### graphFilePath: ${graphTopologyPath}`);
            // this.server.log(['ModuleService', 'info'], `### graphData: ${JSON.stringify(graphTopology, null, 4)}`);
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error while loading graph topology: ${ex.message}`);
        }

        return {
            initialized: false,
            instance: graphInstance,
            topology: graphTopology
        };
    }

    public async startLvaGraph(amsGraph: IAmsGraph): Promise<ICommandResponse> {
        this.server.log(['ModuleService', 'info'], `startLvaGraph`);

        try {
            const methodParams = {
                methodName: ``,
                payload: null,
                connectTimeoutInSeconds: 30,
                responseTimeoutInSeconds: 30
            };

            this.server.log(['ModuleService', 'info'], `### GraphTopologySet`);
            methodParams.methodName = `GraphTopologySet`;
            methodParams.payload = amsGraph.topology;
            await this.moduleClient.invokeMethod(this.moduleSettings[LvaGatewaySettings.GatewayInstanceId], this.moduleSettings[LvaGatewaySettings.LvaEdgeModuleId], methodParams);

            this.server.log(['ModuleService', 'info'], `### GraphInstanceSet`);
            methodParams.methodName = `GraphInstanceSet`;
            methodParams.payload = amsGraph.instance;
            await this.moduleClient.invokeMethod(this.moduleSettings[LvaGatewaySettings.GatewayInstanceId], this.moduleSettings[LvaGatewaySettings.LvaEdgeModuleId], methodParams);

            this.server.log(['ModuleService', 'info'], `### GraphInstanceStart`);
            methodParams.methodName = `GraphInstanceStart`;
            methodParams.payload = amsGraph.instance;
            await this.moduleClient.invokeMethod(this.moduleSettings[LvaGatewaySettings.GatewayInstanceId], this.moduleSettings[LvaGatewaySettings.LvaEdgeModuleId], methodParams);

            const message = `Requested to start LVA Edge graph: ${amsGraph?.instance?.name || ''}`;
            this.server.log(['ModuleService', 'info'], message);

            return {
                statusCode: 201,
                message
            };
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `startLvaGraph error: ${ex.message}`);

            return {
                statusCode: 400,
                message: ex.mesage
            };
        }
    }

    public async stopLvaGraph(amsGraph: IAmsGraph): Promise<ICommandResponse> {
        try {
            const methodParams = {
                methodName: ``,
                payload: null,
                connectTimeoutInSeconds: 30,
                responseTimeoutInSeconds: 30
            };

            if (amsGraph.instance && amsGraph.topology) {
                this.server.log(['ModuleService', 'info'], `### GraphInstanceStop`);
                methodParams.methodName = `GraphInstanceStop`;
                methodParams.payload = amsGraph.instance;
                await this.moduleClient.invokeMethod(this.moduleSettings[LvaGatewaySettings.GatewayInstanceId], this.moduleSettings[LvaGatewaySettings.LvaEdgeModuleId], methodParams);

                this.server.log(['ModuleService', 'info'], `### GraphInstanceDelete`);
                methodParams.methodName = `GraphInstanceDelete`;
                methodParams.payload = amsGraph.instance;
                await this.moduleClient.invokeMethod(this.moduleSettings[LvaGatewaySettings.GatewayInstanceId], this.moduleSettings[LvaGatewaySettings.LvaEdgeModuleId], methodParams);

                this.server.log(['ModuleService', 'info'], `### GraphTopologyDelete`);
                methodParams.methodName = `GraphTopologyDelete`;
                methodParams.payload = amsGraph.topology;
                await this.moduleClient.invokeMethod(this.moduleSettings[LvaGatewaySettings.GatewayInstanceId], this.moduleSettings[LvaGatewaySettings.LvaEdgeModuleId], methodParams);
            }

            const message = `Requested to stop LVA Edge graph: ${amsGraph?.instance?.name || '(no graph was running)'}`;

            return {
                statusCode: 201,
                message
            };
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `stopLvaGraph error: ${ex.message}`);

            return {
                statusCode: 400,
                message: ex.message
            };
        }
    }

    public async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log(['ModuleService', 'info'], `Module restart requested...`);

        try {
            await this.sendMeasurement({
                [LvaGatewayInterface.Event.ModuleRestart]: reason,
                [LvaGatewayInterface.State.ModuleState]: ModuleState.Inactive,
                [LvaGatewayInterface.Event.ModuleStopped]: 'Module restart'
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
            this.server.log(['ModuleService', 'error'], `${ex.message}`);
        }

        // let Docker restart our container
        this.server.log(['ModuleService', 'error'], `Exiting container now`);
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
            this.server.log(['ModuleService', 'error'], `Error reading module properties: ${ex.message}`);
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
            this.server.log(['ModuleService', 'info'], `IOTEDGE_WORKLOADURI: ${this.config.get('IOTEDGE_WORKLOADURI')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_DEVICEID: ${this.config.get('IOTEDGE_DEVICEID')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_MODULEID: ${this.config.get('IOTEDGE_MODULEID')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_MODULEGENERATIONID: ${this.config.get('IOTEDGE_MODULEGENERATIONID')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_IOTHUBHOSTNAME: ${this.config.get('IOTEDGE_IOTHUBHOSTNAME')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_AUTHSCHEME: ${this.config.get('IOTEDGE_AUTHSCHEME')}`);

            this.moduleClient = await ModuleClient.fromEnvironment(Mqtt);
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Failed to instantiate client interface from configuraiton: ${ex.message}`);
        }

        if (!this.moduleClient) {
            return false;
        }

        try {
            await this.moduleClient.open();

            this.server.log(['ModuleService', 'info'], `Client is connected`);

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
                [LvaGatewayDeviceProperties.TotalMemory]: systemProperties.totalMemory
            };

            await this.updateModuleProperties(deviceProperties);

            await this.sendMeasurement({
                [LvaGatewayInterface.State.IoTCentralClientState]: IoTCentralClientState.Connected,
                [LvaGatewayInterface.State.ModuleState]: ModuleState.Active,
                [LvaGatewayInterface.Event.ModuleStarted]: 'Module initialization'
            });

            await this.checkForExistingDevices();
        }
        catch (ex) {
            connectionStatus = `IoT Central connection error: ${ex.message}`;
            this.server.log(['ModuleService', 'error'], connectionStatus);

            result = false;
        }

        return result;
    }

    private async checkForExistingDevices() {
        this.server.log(['ModuleService', 'info'], 'checkForExistingDevices');

        try {
            const deviceListResponse = await this.iotcApiRequest(
                `https://${this.moduleSettings[LvaGatewaySettings.IoTCentralAppHost]}/api/preview/devices`,
                'get',
                {
                    headers: {
                        Authorization: this.moduleSettings[LvaGatewaySettings.IoTCentralAppApiToken]
                    },
                    json: true
                });

            const deviceList = deviceListResponse?.value || [];

            this.server.log(['ModuleService', 'info'], `Found ${deviceList.length} devices`);

            for (const device of deviceList) {
                try {
                    const devicePropertiesResponse = await this.iotcApiRequest(
                        `https://${this.moduleSettings[LvaGatewaySettings.IoTCentralAppHost]}/api/preview/devices/${device.id}/properties`,
                        'get',
                        {
                            headers: {
                                Authorization: this.moduleSettings[LvaGatewaySettings.IoTCentralAppApiToken]
                            },
                            json: true
                        });

                    if (devicePropertiesResponse.IoTCameraDeviceInterface?.[AmsDeviceTag] === AmsDeviceTagValue) {
                        const cameraName = devicePropertiesResponse.IoTCameraDeviceInterface?.rpCameraName;
                        const detectionType = devicePropertiesResponse.LvaEdgeMotionDetectorInterface ? AddCameraDetectionType.Motion : AddCameraDetectionType.Object;

                        this.server.log(['ModuleService', 'info'], `Recreating device: ${device.id} - detectionType: ${detectionType}`);

                        await this.createAmsInferenceDevice(device.id, cameraName, detectionType);
                    }
                }
                catch (ex) {
                    this.server.log(['ModuleService', 'error'], `Failed re-create device: ${ex.message}`);
                }
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Failed to get device list: ${ex.message}`);
        }
    }

    @bind
    private async onHandleDownstreamMessages(inputName: string, message: IoTMessage) {
        if (!this.moduleClient || !message) {
            return;
        }

        try {
            await this.moduleClient.complete(message);

            const messageData = message.getBytes().toString('utf8');
            if (!messageData) {
                return;
            }

            const messageJson = JSON.parse(messageData);

            if (this.moduleSettings[LvaGatewaySettings.DebugRoutedMessage] === true) {
                if (message.properties?.propertyList) {
                    this.server.log(['ModuleService', 'info'], `Routed message properties: ${JSON.stringify(message.properties?.propertyList, null, 4)}`);
                }

                this.server.log(['ModuleService', 'info'], `Routed message data: ${JSON.stringify(messageJson, null, 4)}`);
            }

            switch (inputName) {
                case LvaGatewayEdgeInputs.CameraCommand: {
                    const edgeInputCameraCommand = messageJson?.command;
                    const edgeInputCameraCommandData = messageJson?.data;

                    switch (edgeInputCameraCommand) {
                        case LvaGatewayCommands.CreateCamera:
                            await this.createAmsInferenceDevice(edgeInputCameraCommandData?.cameraId, edgeInputCameraCommandData?.cameraName, edgeInputCameraCommandData?.detectionType);
                            break;

                        case LvaGatewayCommands.DeleteCamera:
                            await this.amsInferenceDeviceOperation('DELETE_CAMERA', edgeInputCameraCommandData);
                            break;

                        case LvaGatewayCommands.SendDeviceTelemetry:
                            await this.amsInferenceDeviceOperation('SEND_TELEMETRY', edgeInputCameraCommandData);
                            break;

                        case LvaGatewayCommands.SendDeviceInferences:
                            await this.amsInferenceDeviceOperation('SEND_INFERENCES', edgeInputCameraCommandData);
                            break;

                        default:
                            this.server.log(['ModuleService', 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
                            break;
                    }

                    break;
                }

                case LvaGatewayEdgeInputs.LvaDiagnostics:
                    this.server.log(['ModuleService', 'info'], `Routed message marker ########## LvaDiagnostics`);
                    break;

                case LvaGatewayEdgeInputs.LvaOperational:
                    this.server.log(['ModuleService', 'info'], `Routed message marker ########## LvaOperational`);
                    break;

                case LvaGatewayEdgeInputs.LvaTelemetry: {
                    const graphSource = this.getGraphSource(message);
                    if (graphSource) {
                        const cameraId = graphSource.substring(graphSource.indexOf('-') + 1);
                        const amsInferenceDevice = this.amsInferenceDeviceMap.get(cameraId);
                        if (!amsInferenceDevice) {
                            this.server.log(['ModuleService', 'error'], `Can't route telemetry to cameraId: ${cameraId}`);
                        }
                        else {
                            await amsInferenceDevice.processLvaInferences(messageJson.inferences);
                        }
                    }

                    break;
                }

                default:
                    this.server.log(['ModuleService', 'warning'], `Warning: received routed message for unknown input: ${inputName}`);
                    break;
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error while handling downstream message: ${ex.message}`);
        }
    }

    private getGraphSource(message: IoTMessage): string {
        const subjectProperty = (message.properties?.propertyList || []).find(property => property.key === 'subject');
        if (subjectProperty) {
            const graphPathElements = (subjectProperty.value || '').split('/');
            if (graphPathElements.length >= 3 && graphPathElements[1] === 'graphInstances') {
                return graphPathElements[2];
            }
        }

        return '';
    }

    private async createAmsInferenceDevice(cameraId: string, cameraName: string, detectionType: AddCameraDetectionType): Promise<IProvisionResult> {
        this.server.log(['ModuleService', 'info'], `createAmsInferenceDevice - cameraId: ${cameraId}, cameraName: ${cameraName}, detectionType: ${detectionType}`);

        let deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            amsInferenceDevice: null
        };

        try {
            if (!cameraId) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing device configuration - skipping DPS provisioning`;

                this.server.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            if (!this.moduleSettings[LvaGatewaySettings.IoTCentralAppHost]
                || !this.moduleSettings[LvaGatewaySettings.IoTCentralAppApiToken]
                || !this.moduleSettings[LvaGatewaySettings.MasterDeviceProvisioningKey]
                || !this.moduleSettings[LvaGatewaySettings.ScopeId]
                || !this.moduleSettings[LvaGatewaySettings.GatewayInstanceId]
                || !this.moduleSettings[LvaGatewaySettings.GatewayModuleId]) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing camera management settings (IoTCentralAppHost, LvaGatewayMangementToken, MasterDeviceProvisioningKey, ScopeId, GatewayInstanceId, GatewayModuleId)`;
                this.server.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            deviceProvisionResult = await this.createAndProvisionAmsInferenceDevice(cameraId, cameraName, detectionType);
            if (deviceProvisionResult.dpsProvisionStatus === true && deviceProvisionResult.clientConnectionStatus === true) {
                this.server.log(['ModuleService', 'info'], `Succesfully provisioned camera device with id: ${cameraId}`);

                this.amsInferenceDeviceMap.set(cameraId, deviceProvisionResult.amsInferenceDevice);

                await this.sendMeasurement({ [LvaGatewayInterface.Event.CreateCamera]: cameraId });
            }
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while processing downstream message: ${ex.message}`;

            this.server.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async createAndProvisionAmsInferenceDevice(cameraId: string, cameraName: string, detectionType: AddCameraDetectionType): Promise<IProvisionResult> {
        this.server.log(['ModuleService', 'info'], `Provisioning device - id: ${cameraId}`);

        const deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            amsInferenceDevice: null
        };

        try {
            const amsGraph = await this.loadAmsGraph(detectionType);

            if (!amsGraph?.instance || !amsGraph?.topology) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Could not load graph topology for the device`;

                return deviceProvisionResult;
            }

            const deviceKey = this.computeDeviceKey(cameraId, this.moduleSettings[LvaGatewaySettings.MasterDeviceProvisioningKey]);
            const provisioningSecurityClient = new SymmetricKeySecurityClient(cameraId, deviceKey);
            const provisioningClient = ProvisioningDeviceClient.create(
                this.dpsProvisioningHost,
                this.moduleSettings[LvaGatewaySettings.ScopeId],
                new ProvisioningTransport(),
                provisioningSecurityClient);

            provisioningClient.setProvisioningPayload({
                iotcModelId: LvaInferenceDeviceMap[detectionType].templateId,
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

                    this.server.log(['ModuleService', 'info'], `DPS registration succeeded - hub: ${dpsResult.assignedHub}`);

                    return resolve(`HostName=${dpsResult.assignedHub};DeviceId=${dpsResult.deviceId};SharedAccessKey=${deviceKey}`);
                });
            });

            deviceProvisionResult.dpsProvisionStatus = true;
            deviceProvisionResult.dpsProvisionMessage = `IoT Central successfully provisioned device: ${cameraId}`;
            deviceProvisionResult.dpsHubConnectionString = dpsConnectionString;

            deviceProvisionResult.amsInferenceDevice = new LvaInferenceDeviceMap[detectionType].deviceClass(this, amsGraph, cameraId, cameraName);

            const { clientConnectionStatus, clientConnectionMessage } = await deviceProvisionResult.amsInferenceDevice.connectDeviceClient(deviceProvisionResult.dpsHubConnectionString);
            deviceProvisionResult.clientConnectionStatus = clientConnectionStatus;
            deviceProvisionResult.clientConnectionMessage = clientConnectionMessage;
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private computeDeviceKey(deviceId: string, masterKey: string) {
        return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64')).update(deviceId, 'utf8').digest('base64');
    }

    private async amsInferenceDeviceOperation(deviceOperation: DeviceOperation, cameraOperationInfo: ICameraOperationInfo): Promise<IDeviceOperationResult> {
        this.server.log(['ModuleService', 'info'], `Processing LVA Edge gateway operation: ${JSON.stringify(cameraOperationInfo, null, 4)}`);

        const operationResult = {
            status: false,
            message: ''
        };

        const cameraId = cameraOperationInfo?.cameraId;
        if (!cameraId) {
            operationResult.message = `Missing cameraId`;

            this.server.log(['ModuleService', 'error'], operationResult.message);

            return operationResult;
        }

        const amsInferenceDevice = this.amsInferenceDeviceMap.get(cameraId);
        if (!amsInferenceDevice) {
            operationResult.message = `No device exists with cameraId: ${cameraId}`;

            this.server.log(['ModuleService', 'error'], operationResult.message);

            return operationResult;
        }

        const operationInfo = cameraOperationInfo?.operationInfo;
        if (!operationInfo) {
            operationResult.message = `Missing operationInfo data`;

            this.server.log(['ModuleService', 'error'], operationResult.message);

            return operationResult;
        }

        switch (deviceOperation) {
            case 'DELETE_CAMERA':
                await this.sendMeasurement({ [LvaGatewayInterface.Event.DeleteCamera]: cameraId });

                await amsInferenceDevice.deleteCamera();
                break;

            case 'SEND_TELEMETRY':
                await amsInferenceDevice.sendTelemetry(operationInfo);
                break;

            case 'SEND_INFERENCES':
                await amsInferenceDevice.processLvaInferences(operationInfo);
                break;

            default:
                this.server.log(['ModuleService', 'error'], `Unkonwn device operation: ${deviceOperation}`);
                break;
        }

        return {
            status: true,
            message: `Success`
        };
    }

    @bind
    private onModuleClientError(error: Error) {
        this.server.log(['ModuleService', 'error'], `Module client connection error: ${error.message}`);
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

            this.server.log(['ModuleService', 'info'], `Module properties updated: ${JSON.stringify(properties, null, 4)}`);
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error updating module properties: ${ex.message}`);
        }
    }

    @bind
    private async onHandleModuleProperties(desiredChangedSettings: any) {
        this.server.log(['ModuleService', 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);

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
                    case LvaGatewayInterface.Setting.IoTCentralAppHost:
                    case LvaGatewayInterface.Setting.IoTCentralAppApiToken:
                    case LvaGatewayInterface.Setting.MasterDeviceProvisioningKey:
                    case LvaGatewayInterface.Setting.ScopeId:
                    case LvaGatewayInterface.Setting.GatewayInstanceId:
                    case LvaGatewayInterface.Setting.GatewayModuleId:
                    case LvaGatewayInterface.Setting.LvaEdgeModuleId:
                    case LvaGatewayInterface.Setting.DebugTelemetry:
                    case LvaGatewayInterface.Setting.DebugRoutedMessage:
                        changedSettingResult = await this.moduleSettingChange(moduleSettingsForPatching, desiredSettingsKey, desiredChangedSettings?.[`${desiredSettingsKey}`]);
                        break;

                    default:
                        this.server.log(['ModuleService', 'error'], `Received desired property change for unknown setting '${desiredSettingsKey}'`);
                        break;
                }

                if (changedSettingResult?.status === true) {
                    patchedProperties[desiredSettingsKey] = changedSettingResult?.value;
                }
            }
            catch (ex) {
                this.server.log(['ModuleService', 'error'], `Exception while handling desired properties: ${ex.message}`);
            }
        }

        for (const moduleSettingsKey in moduleSettingsForPatching) {
            if (!moduleSettingsForPatching.hasOwnProperty(moduleSettingsKey)) {
                continue;
            }

            if (!moduleSettingsForPatching[moduleSettingsKey].handled) {
                this.server.log(['ModuleService', 'info'], `Adding patched property '${moduleSettingsKey}' setting value to: '${this.moduleSettingsDefaults[moduleSettingsKey]}'`);
                patchedProperties[moduleSettingsKey] = this.moduleSettingsDefaults[moduleSettingsKey];
            }

            this.moduleSettings[moduleSettingsKey] = moduleSettingsForPatching[moduleSettingsKey].value;
        }

        if (!emptyObj(patchedProperties)) {
            await this.updateModuleProperties(patchedProperties);
        }

        this.deferredStart.resolve();
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
        this.server.log(['ModuleService', 'info'], `Handle module setting change for '${setting}': ${typeof value === 'object' && value !== null ? JSON.stringify(value, null, 4) : value}`);

        const result = {
            value: undefined,
            status: true
        };

        switch (setting) {
            case LvaGatewayInterface.Setting.IoTCentralAppHost:
            case LvaGatewayInterface.Setting.IoTCentralAppApiToken:
            case LvaGatewayInterface.Setting.MasterDeviceProvisioningKey:
            case LvaGatewayInterface.Setting.ScopeId:
            case LvaGatewayInterface.Setting.GatewayInstanceId:
            case LvaGatewayInterface.Setting.GatewayModuleId:
            case LvaGatewayInterface.Setting.LvaEdgeModuleId:
                result.value = moduleSettingsForPatching[setting].value = value || '';
                moduleSettingsForPatching[setting].handled = true;
                break;

            case LvaGatewayInterface.Setting.DebugTelemetry:
            case LvaGatewayInterface.Setting.DebugRoutedMessage:
                result.value = moduleSettingsForPatching[setting].value = value || false;
                moduleSettingsForPatching[setting].handled = true;
                break;

            default:
                this.server.log(['ModuleService', 'info'], `Unknown module setting change request '${setting}'`);
                result.status = false;
        }

        return result;
    }

    @bind
    private async restartModuleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['ModuleService', 'info'], `${LvaGatewayInterface.Command.RestartModule} command received`);

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
            this.server.log(['ModuleService', 'error'], `Error sending response for ${LvaGatewayInterface.Command.RestartModule} command: ${ex.message}`);
        }
    }

    @bind
    // @ts-ignore
    private async addCameraDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['ModuleService', 'info'], `${LvaGatewayInterface.Command.AddCamera} command received`);

        try {
            const paramPayload = commandRequest?.payload;
            if (typeof paramPayload !== 'object') {
                throw new Error(`Missing or wrong payload time for command: ${LvaGatewayInterface.Command.AddCamera}`);
            }

            const cameraId = paramPayload?.[AddCameraCommandRequestParams.CameraId];
            const cameraName = paramPayload?.[AddCameraCommandRequestParams.CameraName];
            const detectionType = paramPayload?.[AddCameraCommandRequestParams.DetectionType];

            const provisionResult = await this.createAmsInferenceDevice(cameraId, cameraName, detectionType);

            const statusCode = (provisionResult.dpsProvisionStatus === true && provisionResult.clientConnectionStatus === true) ? 201 : 400;

            await commandResponse.send(statusCode, {
                statusCode,
                message: provisionResult.clientConnectionMessage
            });
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error creating LVA Edge gateway camera device: ${ex.message}`);

            await commandResponse.send(400, {
                statusCode: 400,
                message: ex.message
            });
        }
    }

    private async iotcApiRequest(uri, method, options): Promise<any> {
        try {
            const { res, payload } = await Wreck[method](uri, options);

            if (res.statusCode < 200 || res.statusCode > 299) {
                this.server.log(['ModuleService', 'error'], `Response status code = ${res.statusCode}`);

                throw ({
                    message: (payload as any)?.message || payload || 'An error occurred',
                    statusCode: res.statusCode
                });
            }

            return payload;
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `iotcApiRequest: ${ex.message}`);
            throw ex;
        }
    }
}
