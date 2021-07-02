export enum ErrorEnvironment {
    Unknown,
    Genetic,
    History,
    Core,
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
            default:
                return 'Debut unknown error:';
        }
    }
}
