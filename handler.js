'use strict'
const {google} = require('googleapis');
const constants = require('./constants');
const secret = require('./secret');


var savedAuth = null;

module.exports.counters = async event => {
    let parsedAliceRequest = JSON.parse(event.body);
    console.log(event.body);

    if (parsedAliceRequest.session.message_id === 0) {
        const authorizedClient = authorize();

        const countsFileName = getCountsFileName();
        const countsFileId = await getFileId(authorizedClient, countsFileName);

        const statementFileName = getStatementFileName();
        const statementFileId = await getFileId(authorizedClient, statementFileName);

        console.log("countsFileId: " + countsFileId);
        console.log("statementFileId: " + statementFileId);


        const monthName = constants.monthNames[(new Date()).getMonth()];

        if (countsFileId) {
            return aliceResponse(parsedAliceRequest, "Показания счетчиков за " + monthName +
                " уже внесены. Хотите перезаписать показания?",
                [],
                {
                    countsFileId: countsFileId,
                    statementFileId: statementFileId
                });
        } else {
            return aliceResponse(parsedAliceRequest, "Хотите внести показания счетчиков за " + monthName + " ?", [], {});
        }
    }

    if (parsedAliceRequest.session.message_id === 1 && !stop(parsedAliceRequest)) {
        const currentState = getCurrentState(parsedAliceRequest);

        if (currentState) {
            const authorizedClient = authorize();
            if (currentState.countsFileId) {
                await deleteFile(authorizedClient, currentState.countsFileId);
            }
            if (currentState.statementFileId) {
                await deleteFile(authorizedClient, currentState.statementFileId);
            }
        }

        return aliceResponse(parsedAliceRequest, " Если нужно переиспользовать " +
            "показания по счетчику из прошлого месяца, скажите 'переиспользовать'. Начнем. Холодная вода", [], {});
    }

    if (parsedAliceRequest.session.message_id === 2 && !stop(parsedAliceRequest)) {
        const newCountsState = await updateCountsState(parsedAliceRequest, "coldWater");
        return aliceResponse(parsedAliceRequest, "А теперь горячая вода", [], newCountsState);
    }

    if (parsedAliceRequest.session.message_id === 3 && !stop(parsedAliceRequest)) {
        const newCountsState = await updateCountsState(parsedAliceRequest, "hotWater");
        return aliceResponse(parsedAliceRequest, "Переходим к электричеству. Тариф первый, дневной", [], newCountsState);
    }

    if (parsedAliceRequest.session.message_id === 4 && !stop(parsedAliceRequest)) {
        const newCountsState = await updateCountsState(parsedAliceRequest, "electricityDay");
        return aliceResponse(parsedAliceRequest, "А теперь тариф второй, ночной", [], newCountsState);

    }

    if (parsedAliceRequest.session.message_id === 5 && !stop(parsedAliceRequest)) {
        const newCountsState = await updateCountsState(parsedAliceRequest, "electricityNight");
        return aliceResponse(parsedAliceRequest, "Теперь отопление.", [], newCountsState);
    }

    if (parsedAliceRequest.session.message_id === 6 && !stop(parsedAliceRequest)) {
        const newCountsState = await updateCountsState(parsedAliceRequest, "heating");
        const authorizedClient = authorize();
        const countsFileName = getCountsFileName();
        const countsFileContent = JSON.stringify(newCountsState);
        console.log("counts File Content: " + countsFileContent);
        await createFile(authorizedClient, countsFileName, countsFileContent);
        return aliceResponse(
            parsedAliceRequest,
            "Показания счетчиков приняты. Рассчитать задолженность по счетчикам?",
            [],
            newCountsState);
    }

    if (parsedAliceRequest.session.message_id === 7 && !stop(parsedAliceRequest)) {
        const authorizedClient = authorize();
        const previousCountFileName = getCountsFileName(-1);
        const prevCountState = await readFileByName(authorizedClient, previousCountFileName);
        const currentCountsState = getCurrentState(parsedAliceRequest);
        const calculatedCounts = calculateCounts(currentCountsState, prevCountState);

        return aliceResponse(
            parsedAliceRequest,
            "Общая задолженность по счетчикам " + calculatedCounts.calculations.totalCounts + ". Сохранить файл с рассчетами?",
            null,
            calculatedCounts);
    }

    if (parsedAliceRequest.session.message_id === 8 && !stop(parsedAliceRequest)) {
        const authorizedClient = authorize();
        const statementFileName = getStatementFileName();
        const calculatedCounts = getCurrentState(parsedAliceRequest);
        const statementContent = createStatementContent(
            calculatedCounts.countsCurrent,
            calculatedCounts.countsPrevious,
            calculatedCounts.calculations
        )
        await createFile(authorizedClient, statementFileName, statementContent);
        return aliceResponse(parsedAliceRequest,
            "Файл с рассчетами сохранен на google drive", null, {}, true);
    }

    return aliceResponse(parsedAliceRequest, "Закончили", null, {}, true);
};

function readFileByName(authorizedClient, fileName) {
    return getFileId(authorizedClient, fileName)
        .then(
            fileId => readFileById(authorizedClient, fileId),
            err => console.log(err)
        );
}

function calculateCounts(countsCurrent, countsPrevious) {

    const coldWater = (countsCurrent.coldWater - countsPrevious.coldWater) * secret.tariff.coldWater;
    const hotWater = (countsCurrent.hotWater - countsPrevious.hotWater) * secret.tariff.hotWater;
    const electricityDay = (countsCurrent.electricityDay - countsPrevious.electricityDay) * secret.tariff.electricityDay;
    const electricityNight = (countsCurrent.electricityNight - countsPrevious.electricityNight) * secret.tariff.electricityNight;
    const totalCounts = coldWater + hotWater + electricityDay + electricityNight;

    return {
        countsCurrent: countsCurrent,
        countsPrevious: countsPrevious,
        calculations: {
            coldWater: round(coldWater, 2),
            hotWater: round(hotWater, 2),
            electricityDay: round(electricityDay, 2),
            electricityNight: round(electricityNight, 2),
            totalCounts: round(totalCounts, 0)
        }
    };
}

async function updateCountsState(parsedAliceRequest, countName) {
    const authorizedClient = authorize();
    const countsFileName = getCountsFileName();
    let countValue = getCountValue(parsedAliceRequest);
    if (countValue === 0) {
        let prevFileContent = await getPreviousFileContent(authorizedClient);
        countValue = prevFileContent[countName];
    }
    console.log(countValue);
    console.log(countsFileName);

    let currentCountsState = getCurrentState(parsedAliceRequest);
    currentCountsState[countName] = countValue;
    console.log("file: " + JSON.stringify(currentCountsState));
    return currentCountsState;
}

function getCurrentState(parsedAliceRequest) {
    return parsedAliceRequest.state.session;
}

function getPreviousFileContent(authorizedClient) {
    const previousFileName = getCountsFileName(-1);
    return readFileByName(authorizedClient, previousFileName);
}

function readFileById(auth, googleFileId) {
    const drive = google.drive({version: 'v3', auth});
    return drive.files.get({
        fileId: googleFileId,
        alt: 'media'
    }).then(
        res => res.data,
        err => console.log(err)
    );
}

function createFile(auth, name, content) {
    const drive = google.drive({version: 'v3', auth});
    const fileMetadata = {
        name: name,
        parents: [secret.parentFolder]
    };
    const media = {
        mimeType: 'application/json',
        body: content
    };

    return drive.files
        .create({
            resource: fileMetadata,
            media: media,
            fields: 'id'
        })
        .then(
            file => file.id,
            err => console.log(err)
        )
}

function getCountsFileName(offset) {
    if (!offset) {
        offset = 0;
    }
    const d = new Date();
    return "Счетчики_" + d.getFullYear() + "_" + constants.monthNames[d.getMonth() + offset] + ".txt";
}

function getStatementFileName(offset) {
    if (!offset) {
        offset = 0;
    }
    const d = new Date();
    return "Выписка_" + d.getFullYear() + "_" + constants.monthNames[d.getMonth() + offset] + ".txt";
}

function getCountValue(parsedAliceRequest) {
    let nlu = parsedAliceRequest.request.nlu;
    if (nlu && nlu.entities && nlu.entities.length) {
        let entity = nlu.entities[0];
        if (entity.type === "YANDEX.NUMBER") {
            return entity.value;
        }
    }
    return 0;
}

function stop(parsedAliceRequest) {
    let words = parsedAliceRequest.request.nlu;
    if (words && words.tokens) {
        for (let i = 0; i < words.tokens.length; i++) {
            let token = words.tokens[i];
            if (token === "нет" ||
                token === "стоп" ||
                token === "хватит" ||
                token === "закончили" ||
                token === "достаточно" ||
                token === "сбрось"
            ) {
                return true;
            }
        }
    }
    return false;
}

function aliceResponse(parsedAliceRequest, text, hints, sessionState, finishSession) {
    let aliceResponseBody;
    let buttons = [];
    if (!finishSession) {
        finishSession = false;
    }
    if (hints) {
        buttons = hints.map(
            hint => {
                return {
                    "title": hint,
                    "payload": {},
                    "hide": true
                };
            }
        )
    }

    aliceResponseBody = {
        version: parsedAliceRequest.version,
        session: parsedAliceRequest.session,
        session_state: sessionState,
        response: {
            text: text,
            buttons: buttons,
            end_session: finishSession,
        },
    };
    aliceResponseBody = JSON.stringify(aliceResponseBody);
    return {
        statusCode: 200,
        body: aliceResponseBody,
        headers: {
            'Content-Type': 'application/json',
        }
    };
}

function authorize() {
    if (!savedAuth) {
        const {client_secret, client_id, redirect_uris} = secret.credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
        oAuth2Client.setCredentials(secret.accessToken);
        savedAuth = oAuth2Client;
        return oAuth2Client;
    }
    return savedAuth;
}

function deleteFile(auth, fileId) {
    const drive = google.drive({version: 'v3', auth});
    return drive.files.delete({
        fileId: fileId,
    });
}

function getFileId(auth, name) {
    const drive = google.drive({version: 'v3', auth});
    return drive.files.list({
        q: "'" + secret.parentFolder + "' in parents and name='" + name + "'",
        pageSize: 1,
        fields: 'files(id)',
    }).then(
        res => {
            const files = res.data.files;
            if (files.length) {
                console.log("Found file by name " + name + " with id " + files[0].id);
                return files[0].id;
            } else {
                console.log("File not found by name " + name);
                return null;
            }
        },
        err => console.log(err)
    )
}

function createStatementContent(countsCurrent, countsPrevious, calculations) {
    return format(
        constants.statementPattern,
        [
            constants.monthNames[new Date().getMonth()],

            countsPrevious.coldWater,
            countsCurrent.coldWater,
            secret.tariff.coldWater,
            calculations.coldWater,

            countsPrevious.hotWater,
            countsCurrent.hotWater,
            secret.tariff.hotWater,
            calculations.hotWater,

            countsPrevious.electricityDay,
            countsCurrent.electricityDay,
            secret.tariff.electricityDay,
            calculations.electricityDay,

            countsPrevious.electricityNight,
            countsCurrent.electricityNight,
            secret.tariff.electricityNight,
            calculations.electricityNight,

            calculations.totalCounts,
            calculations.totalCounts + secret.tariff.rent
        ]
    );
}

function format(pattern, args) {
    return pattern.replace(/{(\d+)}/g, function (match, number) {
        return typeof args[number] != 'undefined'
            ? args[number]
            : match
            ;
    });
}

function round(number, precision) {
    return parseFloat(number.toFixed(precision));
}