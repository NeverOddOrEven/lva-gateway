import { HealthState } from './health';
import { Mqtt as IoTHubTransport } from 'azure-iot-device-mqtt';
import {
    DeviceMethodRequest,
    DeviceMethodResponse,
    Client as IoTDeviceClient,
    Twin,
    Message as IoTMessage
} from 'azure-iot-device';
import {
    ICameraDeviceProvisionInfo,
    ModuleService
} from './module';
import { AmsGraph } from './amsGraph';
import { bind, defer, emptyObj } from '../utils';

export type DevicePropertiesHandler = (desiredChangedSettings: any) => Promise<void>;

export interface IClientConnectResult {
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
}

interface IoTDeviceInformation {
    manufacturer: string;
    model: string;
    swVersion: string;
    osName: string;
    processorArchitecture: string;
    processorManufacturer: string;
    totalStorage: number;
    totalMemory: number;
}

export enum IoTCameraSettings {
    VideoPlaybackHost = 'wpVideoPlaybackHost'
}

interface IoTCameraSettingsInterface {
    [IoTCameraSettings.VideoPlaybackHost]: string;
}

export const AmsDeviceTag = 'rpAmsDeviceTag';
export const AmsDeviceTagValue = 'AmsInferenceDevice.v1';

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum CameraState {
    Inactive = 'inactive',
    Active = 'active'
}

const IoTCameraInterface = {
    Telemetry: {
        SystemHeartbeat: 'tlSystemHeartbeat'
    },
    State: {
        IoTCentralClientState: 'stIoTCentralClientState',
        CameraState: 'stCameraState'
    },
    Property: {
        CameraName: 'rpCameraName',
        RtspUrl: 'rpRtspUrl',
        RtspAuthUsername: 'rpRtspAuthUsername',
        RtspAuthPassword: 'rpRtspAuthPassword',
        AmsDeviceTag
    },
    Setting: {
        VideoPlaybackHost: IoTCameraSettings.VideoPlaybackHost
    }
};

enum LvaEdgeOperationsSettings {
    AutoStart = 'wpAutoStart'
}

interface LvaEdgeOperationsSettingsInterface {
    [LvaEdgeOperationsSettings.AutoStart]: boolean;
}

const LvaEdgeOperationsInterface = {
    Event: {
        GraphInstanceCreated: 'evGraphInstanceCreated',
        GraphInstanceDeleted: 'evGraphInstanceDeleted',
        GraphInstanceStarted: 'evGraphInstanceStarted',
        GraphInstanceStopped: 'evGraphInstanceStopped',
        RecordingStarted: 'evRecordingStarted',
        RecordingStopped: 'evRecordingStopped',
        RecordingAvailable: 'evRecordingAvailable',
        StartLvaGraphCommandReceived: 'evStartLvaGraphCommandReceived',
        StopLvaGraphCommandReceived: 'evStopLvaGraphCommandReceived'
    },
    Setting: {
        AutoStart: LvaEdgeOperationsSettings.AutoStart
    },
    Command: {
        StartLvaProcessing: 'cmStartLvaProcessing',
        StopLvaProcessing: 'cmStopLvaProcessing'
    }
};

enum LvaEdgeDiagnosticsSettings {
    DebugTelemetry = 'wpDebugTelemetry'
}

interface LvaEdgeDiagnosticsSettingsInterface {
    [LvaEdgeDiagnosticsSettings.DebugTelemetry]: boolean;
}

const LvaEdgeDiagnosticsInterface = {
    Event: {
        RuntimeError: 'evRuntimeError',
        AuthenticationError: 'evAuthenticationError',
        AuthorizationError: 'evAuthorizationError',
        DataDropped: 'evDataDropped',
        MediaFormatError: 'evMediaFormatError',
        MediaSessionEstablished: 'evMediaSessionEstablished',
        NetworkError: 'evNetworkError',
        ProtocolError: 'evProtocolError',
        StorageError: 'evStorageError'
    },
    Setting: {
        DebugTelemetry: LvaEdgeDiagnosticsSettings.DebugTelemetry
    }
};

export const AiInferenceInterface = {
    Telemetry: {
        InferenceCount: 'tlInferenceCount',
        Inference: 'tlInference'
    },
    Event: {
        InferenceEventVideoUrl: 'evInferenceEventVideoUrl'
    },
    Property: {
        InferenceVideoUrl: 'rpInferenceVideoUrl',
        InferenceImageUrl: 'rpInferenceImageUrl'
    }
};

export abstract class AmsCameraDevice {
    protected lvaGatewayModule: ModuleService;
    protected amsGraph: AmsGraph;
    protected cameraInfo: ICameraDeviceProvisionInfo;
    protected assetName: string;
    protected deviceClient: IoTDeviceClient;
    protected deviceTwin: Twin;

    protected deferredStart = defer();
    protected healthState = HealthState.Good;
    protected activeVideoInference: boolean = false;
    protected lastInferenceTime: number = 0;
    protected iotCameraSettings: IoTCameraSettingsInterface = {
        [IoTCameraSettings.VideoPlaybackHost]: 'localhost:8094'
    };
    protected lvaEdgeOperationsSettings: LvaEdgeOperationsSettingsInterface = {
        [LvaEdgeOperationsSettings.AutoStart]: false
    };
    protected lvaEdgeDiagnosticsSettings: LvaEdgeDiagnosticsSettingsInterface = {
        [LvaEdgeDiagnosticsSettings.DebugTelemetry]: false
    };

    constructor(lvaGatewayModule: ModuleService, amsGraph: AmsGraph, cameraInfo: ICameraDeviceProvisionInfo) {
        this.lvaGatewayModule = lvaGatewayModule;
        this.amsGraph = amsGraph;
        this.cameraInfo = cameraInfo;
    }

    public abstract setGraphParameters(): any;
    public abstract async deviceReady(): Promise<void>;
    public abstract async processLvaInferences(inferenceData: any): Promise<void>;
    public abstract async inferenceTimer(): Promise<void>;

    public async connectDeviceClient(dpsHubConnectionString: string): Promise<IClientConnectResult> {
        let clientConnectionResult: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        try {
            clientConnectionResult = await this.connectDeviceClientInternal(dpsHubConnectionString, this.onHandleDeviceProperties);

            if (clientConnectionResult.clientConnectionStatus === true) {
                await this.deferredStart.promise;

                await this.deviceReady();

                setInterval(async () => {
                    await this.inferenceTimer();
                }, 3000);
            }

            if (this.lvaEdgeOperationsSettings[LvaEdgeOperationsSettings.AutoStart] === true) {
                try {
                    await this.startLvaProcessingInternal(true);
                }
                catch (ex) {
                    this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `Error while trying to auto-start Lva graph: ${ex.message}`);
                }
            }
        }
        catch (ex) {
            clientConnectionResult.clientConnectionStatus = false;
            clientConnectionResult.clientConnectionMessage = `An error occurred while accessing the device twin properties`;
        }

        return clientConnectionResult;
    }

    @bind
    public async getHealth(): Promise<number> {
        await this.sendMeasurement({
            [IoTCameraInterface.Telemetry.SystemHeartbeat]: this.healthState
        });

        return this.healthState;
    }

    public async deleteCamera(): Promise<void> {
        this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `Deleting camera device instance for cameraId: ${this.cameraInfo.cameraId}`);

        try {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `Deactiving graph instance: ${this.amsGraph.getInstanceName()}`);

            await this.amsGraph.deleteLvaGraph();

            const clientInterface = this.deviceClient;
            this.deviceClient = null;
            await clientInterface.close();

            await this.sendMeasurement({
                [IoTCameraInterface.State.CameraState]: CameraState.Inactive
            });
        }
        catch (ex) {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `Error while deleting camera: ${this.cameraInfo.cameraId}`);
        }
    }

    public async sendLvaEvent(lvaEvent: string, messageJson?: any): Promise<void> {
        let eventField;
        let eventValue = this.cameraInfo.cameraId;

        switch (lvaEvent) {
            case 'Microsoft.Media.Graph.Operational.RecordingStarted':
                eventField = LvaEdgeOperationsInterface.Event.RecordingStarted;
                eventValue = this.assetName;
                break;

            case 'Microsoft.Media.Graph.Operational.RecordingStopped':
                eventField = LvaEdgeOperationsInterface.Event.RecordingStopped;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Operational.RecordingAvailable':
                eventField = LvaEdgeOperationsInterface.Event.RecordingAvailable;
                eventValue = messageJson?.outputLocation || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Edge.Diagnostics.RuntimeError':
                eventField = LvaEdgeDiagnosticsInterface.Event.RuntimeError;
                eventValue = messageJson?.code || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.AuthenticationError':
                eventField = LvaEdgeDiagnosticsInterface.Event.AuthenticationError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.AuthorizationError':
                eventField = LvaEdgeDiagnosticsInterface.Event.AuthorizationError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.DataDropped':
                eventField = LvaEdgeDiagnosticsInterface.Event.DataDropped;
                eventValue = messageJson?.dataType || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.MediaFormatError':
                eventField = LvaEdgeDiagnosticsInterface.Event.MediaFormatError;
                eventValue = messageJson?.code || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.MediaSessionEstablished':
                eventField = LvaEdgeDiagnosticsInterface.Event.MediaSessionEstablished;
                eventValue = this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.NetworkError':
                eventField = LvaEdgeDiagnosticsInterface.Event.NetworkError;
                eventValue = messageJson?.errorCode || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.ProtocolError':
                eventField = LvaEdgeDiagnosticsInterface.Event.ProtocolError;
                eventValue = `${messageJson?.protocol}: ${messageJson?.errorCode}` || this.cameraInfo.cameraId;
                break;

            case 'Microsoft.Media.Graph.Diagnostics.StorageError':
                eventField = LvaEdgeDiagnosticsInterface.Event.StorageError;
                eventValue = messageJson?.storageAccountName || this.cameraInfo.cameraId;
                break;

            default:
                this.lvaGatewayModule.logger(['AmsCameraDevice', 'warning'], `Received Unknown Lva event telemetry: ${lvaEvent}`);
                break;
        }

        if (lvaEvent) {
            await this.sendMeasurement({
                [eventField]: eventValue
            });
        }
        else {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'warning'], `Received Unknown Lva event telemetry: ${lvaEvent}`);
        }
    }

    protected abstract async onHandleDeviceProperties(desiredChangedSettings: any);

    protected async onHandleDevicePropertiesInternal(desiredChangedSettings: any) {
        try {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `desiredPropsDelta:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);

            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!desiredChangedSettings.hasOwnProperty(setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = desiredChangedSettings[`${setting}`]?.value;

                switch (setting) {
                    case IoTCameraInterface.Setting.VideoPlaybackHost:
                        patchedProperties[setting] = (this.iotCameraSettings[setting] as any) = value || '';
                        break;

                    case LvaEdgeOperationsInterface.Setting.AutoStart:
                        patchedProperties[setting] = (this.lvaEdgeOperationsSettings[setting] as any) = value || false;
                        break;

                    case LvaEdgeDiagnosticsInterface.Setting.DebugTelemetry:
                        patchedProperties[setting] = (this.lvaEdgeDiagnosticsSettings[setting] as any) = value || false;

                    default:
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.updateDeviceProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `Exception while handling desired properties: ${ex.message}`);
        }
    }

    protected async updateDeviceProperties(properties: any): Promise<void> {
        if (!properties || !this.deviceTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.deviceTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve();
                });
            });

            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `Device live properties updated: ${JSON.stringify(properties, null, 4)}`);
        }
        catch (ex) {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `Error while updating client properties: ${ex.message}`);
        }
    }

    protected async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.deviceClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.deviceClient.sendEvent(iotcMessage);

            if (this.lvaEdgeDiagnosticsSettings[LvaEdgeDiagnosticsSettings.DebugTelemetry] === true) {
                this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `sendMeasurement: ${ex.message}`);
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `inspect the error: ${JSON.stringify(ex, null, 4)}`);

            // TODO:
            // Detect DPS/Hub reprovisioning scenarios - sample exeption:
            //
            // [12:41:54 GMT+0000], [log,[AmsCameraDevice, error]] data: inspect the error: {
            //     "name": "UnauthorizedError",
            //     "transportError": {
            //         "name": "NotConnectedError",
            //         "transportError": {
            //             "code": 5
            //         }
            //     }
            // }
        }
    }

    protected async startLvaProcessingInternal(autoStart: boolean): Promise<boolean> {
        await this.sendMeasurement({
            [LvaEdgeOperationsInterface.Event.StartLvaGraphCommandReceived]: autoStart ? 'AutoStart' : 'Command'
        });

        const startLvaGraphResult = await this.amsGraph.startLvaGraph(this.setGraphParameters());

        if (this.lvaEdgeDiagnosticsSettings[LvaEdgeDiagnosticsSettings.DebugTelemetry] === true) {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `Graph Instance Name: ${JSON.stringify(this.amsGraph.getInstanceName(), null, 4)}`);
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `Graph Instance: ${JSON.stringify(this.amsGraph.getInstance(), null, 4)}`);
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `Graph Topology Name: ${JSON.stringify(this.amsGraph.getInstanceName(), null, 4)}`);
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `Graph Topology: ${JSON.stringify(this.amsGraph.getTopology(), null, 4)}`);
        }

        await this.sendMeasurement({
            [IoTCameraInterface.State.CameraState]: startLvaGraphResult === true ? CameraState.Active : CameraState.Inactive
        });

        return startLvaGraphResult;
    }

    private async connectDeviceClientInternal(
        dpsHubConnectionString: string,
        devicePropertiesHandler: DevicePropertiesHandler): Promise<IClientConnectResult> {

        const result: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        if (this.deviceClient) {
            await this.deviceClient.close();
            this.deviceClient = null;
        }

        try {
            this.deviceClient = await IoTDeviceClient.fromConnectionString(dpsHubConnectionString, IoTHubTransport);
            if (!this.deviceClient) {
                result.clientConnectionStatus = false;
                result.clientConnectionMessage = `Failed to connect device client interface from connection string - device: ${this.cameraInfo.cameraId}`;
            }
            else {
                result.clientConnectionStatus = true;
                result.clientConnectionMessage = `Successfully connected to IoT Central - device: ${this.cameraInfo.cameraId}`;
            }
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `Failed to instantiate client interface from configuraiton: ${ex.message}`;

            this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `${result.clientConnectionMessage}`);
        }

        if (result.clientConnectionStatus === false) {
            return result;
        }

        try {
            await this.deviceClient.open();

            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `Device client is connected`);

            this.deviceTwin = await this.deviceClient.getTwin();
            this.deviceTwin.on('properties.desired', devicePropertiesHandler);

            this.deviceClient.on('error', this.onDeviceClientError);

            this.deviceClient.onDeviceMethod(LvaEdgeOperationsInterface.Command.StartLvaProcessing, this.startLvaProcessing);
            this.deviceClient.onDeviceMethod(LvaEdgeOperationsInterface.Command.StopLvaProcessing, this.stopLvaProcessing);

            const cameraProps = await this.getCameraProps();

            await this.updateDeviceProperties({
                ...cameraProps,
                [IoTCameraInterface.Property.CameraName]: this.cameraInfo.cameraName,
                [IoTCameraInterface.Property.RtspUrl]: this.cameraInfo.rtspUrl,
                [IoTCameraInterface.Property.RtspAuthUsername]: this.cameraInfo.rtspAuthUsername,
                [IoTCameraInterface.Property.RtspAuthPassword]: this.cameraInfo.rtspAuthPassword,
                [IoTCameraInterface.Property.AmsDeviceTag]: `${this.lvaGatewayModule.getInstanceId()}:${AmsDeviceTagValue}`,
                [IoTCameraInterface.Setting.VideoPlaybackHost]: this.iotCameraSettings[IoTCameraSettings.VideoPlaybackHost],
                [LvaEdgeOperationsInterface.Setting.AutoStart]: this.lvaEdgeOperationsSettings[LvaEdgeOperationsSettings.AutoStart],
                [LvaEdgeDiagnosticsInterface.Setting.DebugTelemetry]: this.lvaEdgeOperationsSettings[LvaEdgeDiagnosticsSettings.DebugTelemetry]
            });

            await this.sendMeasurement({
                [IoTCameraInterface.State.IoTCentralClientState]: IoTCentralClientState.Connected,
                [IoTCameraInterface.State.CameraState]: CameraState.Inactive
            });

            result.clientConnectionStatus = true;
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `IoT Central connection error: ${ex.message}`;

            this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    private async getCameraProps(): Promise<IoTDeviceInformation> {
        // TODO:
        // Introduce some ONVIF tech to get camera props
        return {
            manufacturer: 'Axis',
            model: '1367',
            swVersion: 'v1.0.0',
            osName: 'Axis OS',
            processorArchitecture: 'Axis CPU',
            processorManufacturer: 'Axis',
            totalStorage: 0,
            totalMemory: 0
        };
    }

    @bind
    private onDeviceClientError(error: Error) {
        this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `Device client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    // @ts-ignore
    private async startLvaProcessing(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `${LvaEdgeOperationsInterface.Command.StartLvaProcessing} command received`);

        try {
            const startLvaGraphResult = await this.startLvaProcessingInternal(false);

            const responseMessage = `LVA Edge start graph request: ${startLvaGraphResult ? 'succeeded' : 'failed'}`;
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], responseMessage);

            await commandResponse.send(202);
            await this.updateDeviceProperties({
                [LvaEdgeOperationsInterface.Command.StartLvaProcessing]: {
                    value: responseMessage
                }
            });
        }
        catch (ex) {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `startLvaProcessing error: ${ex.message}`);
        }
    }

    @bind
    // @ts-ignore
    private async stopLvaProcessing(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], `${LvaEdgeOperationsInterface.Command.StopLvaProcessing} command received`);

        try {
            await this.sendMeasurement({
                [LvaEdgeOperationsInterface.Event.StopLvaGraphCommandReceived]: this.cameraInfo.cameraId
            });

            const stopLvaGraphResult = await this.amsGraph.stopLvaGraph();
            if (stopLvaGraphResult) {
                await this.sendMeasurement({
                    [IoTCameraInterface.State.CameraState]: CameraState.Inactive
                });
            }

            const responseMessage = `LVA Edge stop graph request: ${stopLvaGraphResult ? 'succeeded' : 'failed'}`;
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'info'], responseMessage);

            await commandResponse.send(202);
            await this.updateDeviceProperties({
                [LvaEdgeOperationsInterface.Command.StopLvaProcessing]: {
                    value: responseMessage
                }
            });
        }
        catch (ex) {
            this.lvaGatewayModule.logger(['AmsCameraDevice', 'error'], `Stop LVA error ${ex.message}`);
        }
    }
}
