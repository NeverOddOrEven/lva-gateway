import {
    ICameraDeviceProvisionInfo,
    ModuleService
} from './module';
import { AmsGraph } from './amsGraph';
import {
    AiInferenceInterface,
    AmsCameraDevice
} from './device';
import * as moment from 'moment';
import { bind, emptyObj } from '../utils';

interface IMotionInference {
    type: string;
    motion: {
        box: {
            l: number,
            t: number,
            w: number,
            h: number
        }
    };
}

enum MotionDetectorSensitivity {
    Low = 'low',
    Medium = 'medium',
    High = 'high'
}

enum MotionDetectorSettings {
    Sensitivity = 'wpSensitivity'
}

interface IMotionDetectorSettings {
    [MotionDetectorSettings.Sensitivity]: MotionDetectorSensitivity;
}

const MotionDetectorInterface = {
    Setting: {
        Sensitivity: MotionDetectorSettings.Sensitivity
    }
};

export class AmsMotionDetectorDevice extends AmsCameraDevice {
    private motionDetectorSettings: IMotionDetectorSettings = {
        [MotionDetectorSettings.Sensitivity]: MotionDetectorSensitivity.Medium
    };

    constructor(lvaGatewayModule: ModuleService, amsGraph: AmsGraph, cameraInfo: ICameraDeviceProvisionInfo) {
        super(lvaGatewayModule, amsGraph, cameraInfo);
    }

    public setGraphParameters(): any {
        return {
            motionSensitivity: this.motionDetectorSettings[MotionDetectorSettings.Sensitivity],
            assetName: `${this.lvaGatewayModule.getScopeId()}-${this.cameraInfo.cameraId}-${moment.utc().format('YYYYMMDD-HHmmss')}`
        };
    }

    public async deviceReady(): Promise<void> {
        this.lvaGatewayModule.logger(['AmsMotionDetectorDevice', 'info'], `Device is ready`);

        await this.updateDeviceProperties({
            [AiInferenceInterface.Property.InferenceImageUrl]: 'https://iotcsavisionai.blob.core.windows.net/image-link-test/rtspcapture.jpg'
        });
    }

    public async processLvaInferences(inferences: IMotionInference[]): Promise<void> {
        if (!Array.isArray(inferences) || !this.deviceClient) {
            this.lvaGatewayModule.logger(['AmsMotionDetectorDevice', 'error'], `Missing inferences array or client not connected`);
            return;
        }

        try {
            let inferenceCount = 0;

            for (const inference of inferences) {
                ++inferenceCount;

                await this.sendMeasurement({
                    [AiInferenceInterface.Telemetry.Inference]: inference
                });
            }

            if (inferenceCount > 0) {
                this.lastInferenceTime = moment.utc();

                await this.sendMeasurement({
                    [AiInferenceInterface.Telemetry.InferenceCount]: inferenceCount
                });
            }
        }
        catch (ex) {
            this.lvaGatewayModule.logger(['AmsMotionDetectorDevice', 'error'], `Error processing downstream message: ${ex.message}`);
        }
    }

    @bind
    protected async onHandleDeviceProperties(desiredChangedSettings: any) {
        await super.onHandleDevicePropertiesInternal(desiredChangedSettings);

        try {
            this.lvaGatewayModule.logger(['AmsMotionDetectorDevice', 'info'], `desiredPropsDelta:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);

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
                    case MotionDetectorInterface.Setting.Sensitivity:
                        patchedProperties[setting] = this.motionDetectorSettings[setting] = value || '';
                        break;

                    default:
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.updateDeviceProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.lvaGatewayModule.logger(['AmsMotionDetectorDevice', 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }
}
