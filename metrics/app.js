const express = require('express')
const app = express()
const fetch = require('node-fetch')
const createCsvWriter = require('csv-writer').createObjectCsvWriter
const nodemailer = require('nodemailer')
const serverless = require('serverless-http')

/**
 * Constant that holds the GitHub token which is read out of the environment and is required for the GitHub-API.
 */
const GH_TOKEN = Object.freeze(process.env['MEGA_METRICS_GH_TOKEN'])

/**
 * Constant that holds the password which is read out of the environment and is required for 
 * sending emails.
 */
const MAILER_PASS = Object.freeze(process.env['MAILER_PASS'])

/**
 * Constant that holds the directory where the generated file will be written to.
 * Therefore, a check whether the application is running online or offline is performed.
 * When the application is running online (on AWS), the file is written to the directory /tmp,
 * which is a temporary directory provided by AWS and allows to write around 500 MB of data
 * during the execution of the Lambda function. When the method is fully executed, 
 * this temporary directory gets deleted on the server.
 */
const PATH_FOR_CSV = process.env.IS_OFFLINE ? 'tmp' : '/tmp'

/**
 * Constant that holds the current date.
 */
const DATE = new Date().toISOString().substr(0, 10);


/**
 * Constant that specifies the object used for writing data into a csv-file.
 * @type {CsvWriter<unknown>}
 */
const csvWriter = createCsvWriter({
    path: `${PATH_FOR_CSV}/metrics_${DATE}.csv`,
    header: [
        {id: 'number', title: 'Number'},
        {id: 'title', title: 'Title'},
        {id: 'label', title: 'Label'},
        {id: 'backlog', title: 'backlog [WIP min 3]'},
        {id: 'development', title: 'in development [WIP 4]'},
        {id: 'approved_for_test', title: 'approved for TEST'},
        {id: 'deployed_to_test', title: 'deployed to TEST'},
        {id: 'approved_for_prod', title: 'approved for PROD'},
    ],
    fieldDelimiter: ';',
    headerIdDelimiter: ';'
})

/**
 * Constant that specifies the mail provider and the credentials for the account that is used for the authentication.
 * @type {Readonly<Mail>}
 */
const transporter = Object.freeze(nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'oliver.tod@gepardec.com',
        pass: MAILER_PASS
    }
}))

/**
 * Constant that specifies attributes for sending mails and its content
 * @type {Readonly<{attachments: {path: string}, subject: string, from: string, to: [string, string], text: string}>}
 */
const mailOptions = Object.freeze({
    from: 'oliver.tod@gepardec.com',
    to: ['stefan.hausmann@gepardec.com', 'olivertod11@yahoo.de'],
    subject: 'GitHub Metriken für MEGA',
    text: 'Hallo, \n\n Im Anhang findest du die Metriken von MEGA als CSV-Datei.\n\nLG',
    attachments: {
        path: `${PATH_FOR_CSV}/metrics_${DATE}.csv`
    }
})

/**
 * Constant that specifies the lower limit of the ticket number.
 * Only tickets whose number is equal or above this constant get evaluated.
 * @type {Readonly<number>}
 */
const TICKETS_ABOVE_INCLUDING = Object.freeze(106)

/**
 * Array that specifies the columns corresponding to the GitHub-Kanban-Board.
 * @type {string[]}
 */
const steps = Object.freeze([
    'backlog [WIP min 3]',
    'in development [WIP 4]',
    'approved for TEST',
    'deployed to TEST',
    'approved for PROD'
])


// TODO: generify the column names and improve handling of different column names that mean the same column (e.g. backlog vs. backlog [WIP min 3])
exports.fetchMetrics = async function () {

    let count = 0
    let page = 1
    let issues
    let metrics = []
    let done = false

    do {
        issues = await fetchIssuesOfRepo(page++)
        for (let issue of issues) {
            let obj

            // only use issues that are not a pull request
            if (!issue.hasOwnProperty('pull_request')) {
                let labelToSet = ''
                if (issue.hasOwnProperty('labels') && issue.labels.length !== 0) {
                    for (let label of issue.labels) {
                        if (label.name === 'user story' || label.name === 'technical story' || label.name === 'bug') {
                            labelToSet = label.name
                            break
                        }
                    }
                }

                obj = {
                    "number": issue.number,
                    "title": issue.title,
                    "label": labelToSet,
                    "closed_at": issue.closed_at ? issue.closed_at.substr(0, issue.closed_at.indexOf('T')) : issue.closed_at,
                    "events": []
                }

                let events = await fetchEventsForIssue(issue.number)
                for (let event of events) {
                    if (event.event === 'added_to_project' || event.event === 'moved_columns_in_project' || event.event === 'converted_note_to_issue') {
                        if (event.hasOwnProperty('project_card') && event.project_card.project_id === 4946323) {
                            let prevColumn = event.project_card.previous_column_name
                            let currentColumn = event.project_card.column_name
                            if (currentColumn !== 'pre-backlog' && currentColumn !== 'triage') {
                                let newEvent = {
                                    "column": currentColumn,
                                    "date": event.created_at.substr(0, event.created_at.indexOf('T'))
                                }

                                if (obj.events.every(value => value.column !== currentColumn)) {
                                    obj.events.push(newEvent)
                                } else {
                                    if (steps.includes(prevColumn)) {
                                        let columnsToReset = steps.slice(steps.indexOf(currentColumn) + 1, steps.indexOf(prevColumn) + 1)
                                        for (let columnName of columnsToReset) {
                                            let matchingEvent = obj.events.find(value => value.column === columnName)
                                            if (matchingEvent) {
                                                if (newEvent.column === columnName) {
                                                    obj.events.splice(obj.events.indexOf(matchingEvent), 1, newEvent)
                                                } else {
                                                    obj.events.splice(obj.events.indexOf(matchingEvent), 1)
                                                }
                                            }
                                        }
                                    }
                                }
                            } else {
                                obj.events = []
                            }
                        }
                    } else if (event.event === 'removed_from_project') {
                        obj.events = []
                    } else if (event.event === 'closed') {
                        if (obj.events.every(value => value.column !== steps[steps.length - 1]) && obj.events.length > 0) {
                            obj.events.push({
                                "column": steps[steps.length - 1],
                                "date": event.created_at.substr(0, event.created_at.indexOf('T'))
                            })
                        }
                    }
                }
            }

            if (obj && obj.events.length > 0) {
                count++
                metrics.push(obj)
            }

            if (issue.number === TICKETS_ABOVE_INCLUDING) {
                done = true
                break
            }
        }
    } while (Object.keys(issues).length === 30 && !done)

    console.log(`Number of issues: ${count}`)
    console.log('--------------------------')

    await generateCsvData(metrics)
}


/**
 * Converts the given data into an appropriate format for writing it to a external csv-file.
 * @param metrics
 */
const generateCsvData = async (metrics) => {

    let csvData = []
    for (let issue of metrics) {

        let csvEntry = {
            number: issue.number,
            title: issue.title,
            label: issue.label,
            backlog: "",
            development: "",
            approved_for_test: "",
            deployed_to_test: "",
            approved_for_prod: ""
        }

        for (let event of issue.events) {
            if (event.column.includes('backlog')) {
                csvEntry.backlog = event.date
            } else if (event.column.includes('development')) {
                csvEntry.development = event.date
            } else if (event.column === 'approved for TEST') {
                csvEntry.approved_for_test = event.date
            } else if (event.column === 'deployed to TEST') {
                csvEntry.deployed_to_test = event.date
            } else if (event.column === 'approved for PROD') {
                csvEntry.approved_for_prod = event.date
            }
        }

        if (!isEmpty(issue.closed_at) && isEmpty(csvEntry.approved_for_prod)) {
            csvEntry.approved_for_prod = issue.closed_at
        }
        csvData.push(csvEntry)
    }

    csvData = workaroundDates(csvData)

    try {
        await csvWriter.writeRecords(csvData);
        console.log('The CSV file was written successfully')
        let info = await transporter.sendMail(mailOptions)
        console.log(`Email was sent successfully: ${info.response}`)
    } catch (e) {
        console.error(e)
    }
}


/**
 * Helper method (probably temporary) that is used to fill dates into columns which a ticket haven't been pulled into, but which it must have already passed due to the defined process.
 * @param csvData The already preprocessed data that the action has to be performed on.
 * @returns {*} The same data with modifications performed by this method.
 */
function workaroundDates(csvData) {

    for (let csvEntry of csvData) {
        if (isEmpty(csvEntry.deployed_to_test) && !isEmpty(csvEntry.approved_for_prod)) {
            csvEntry.deployed_to_test = csvEntry.approved_for_prod
        }
        if (isEmpty(csvEntry.approved_for_test) && !isEmpty(csvEntry.deployed_to_test)) {
            csvEntry.approved_for_test = csvEntry.deployed_to_test
        }
        if (isEmpty(csvEntry.development) && !isEmpty(csvEntry.approved_for_test)) {
            csvEntry.development = csvEntry.approved_for_test
        }
        if (isEmpty(csvEntry.backlog) && !isEmpty(csvEntry.development)) {
            csvEntry.backlog = csvEntry.development
        }
    }
    return csvData
}

/**
 * Checks if the given string is empty or null.
 * @param str A string.
 * @returns {boolean} true if given string is either null or undefined or has a length of zero, false otherwise.
 */
function isEmpty(str) {
    return (!str || 0 === str.length)
}


/**
 * Fetches data about GitHub-Issues.
 * @param page Page number of the results to fetch.
 * @param owner Name of the GitHub user or organization.
 * @param repo Name of the repository.
 * @returns {Promise<*>}
 */
const fetchIssuesOfRepo = async (page, owner = 'Gepardec', repo = 'mega') => {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=all&page=${page}`, {
        headers: {
            'Authorization': `token ${GH_TOKEN}`,
        }
    })
    return await response.json()
}

/**
 * Fetches data about occurred events associated with an issue.
 * @param issueNr Number of the issue.
 * @param owner Name of the GitHub user or organization.
 * @param repo Name of the repository.
 * @returns {Promise<*>}
 */
const fetchEventsForIssue = async (issueNr, owner = 'Gepardec', repo = 'mega') => {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNr}/events`, {
        headers: {
            'Authorization': `token ${GH_TOKEN}`,
            'Accept': 'application/vnd.github.starfox-preview+json'
        }
    })
    return await response.json()
}

exports.apiProxyHandler = serverless(app);
