export enum ErrorEnvironment {
    Unknown,
    Genetic,
    History,
    Core,
    Transport,
    Tester,
}

export class DebutError {
    public message: string;

    constructor(public env: ErrorEnvironment, msg: string) {
        this.message = `${this.getErrorMessage()}  ${msg}`;
    }

    private getErrorMessage() {
        switch (this.env) {
            case ErrorEnvironment.History:
                return 'Debut history error:';
            case ErrorEnvironment.Core:
                return 'Debut core error:';
            case ErrorEnvironment.Genetic:
                return 'Debut genetic error:';
            case ErrorEnvironment.Tester:
                return 'Debut tester error:';
            case ErrorEnvironment.Transport:
                return 'Debut transport error:';
            default:
                return 'Debut unknown error:';
        }
    }

    toString() {
        return this.message;
    }
}
